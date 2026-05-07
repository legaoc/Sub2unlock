import TelegramBot from “node-telegram-bot-api”;
import { db, firebaseAdmin } from “./firebase.js”;

const TOKEN = process.env[“TOKEN”];
const MI_ID_ADMIN = parseInt(process.env[“MI_ID_ADMIN”] ?? “0”);
const PALABRA_MAGICA = “/panel”;

if (!TOKEN) throw new Error(“TOKEN environment variable is required.”);
if (!MI_ID_ADMIN) throw new Error(“MI_ID_ADMIN environment variable is required.”);

const bot = new TelegramBot(TOKEN, { polling: true });

const estadosCreacion = {};

console.log(“Sub2Unlock Bot iniciado.”);

// ==========================================
// HELPERS
// ==========================================

function fechaVencimientoDefault() {
const f = new Date();
f.setDate(f.getDate() + 30);
return f;
}

function formatearFecha(ts) {
if (!ts) return “Sin fecha”;
return ts.toDate().toLocaleDateString(“es-ES”, {
day: “2-digit”, month: “2-digit”, year: “numeric”,
hour: “2-digit”, minute: “2-digit”,
});
}

function tiempoRestante(ts) {
if (!ts) return “❓ Sin fecha”;
const diff = ts.toDate().getTime() - Date.now();
if (diff <= 0) return “🔴 Vencido”;
const dias = Math.floor(diff / 86400000);
const horas = Math.floor((diff % 86400000) / 3600000);
if (dias > 0) return `🟢 ${dias}d ${horas}h restantes`;
return `🟡 ${horas}h restantes`;
}

async function estaVigente(userId) {
if (userId === MI_ID_ADMIN) return true;
const doc = await db.collection(“creadores”).doc(userId.toString()).get();
if (!doc.exists) return false;
const data = doc.data();
if (!data[“activo”]) return false;
const venc = data[“fechaVencimiento”];
return !!venc && venc.toDate() > new Date();
}

function obtenerCanales(data) {
if (Array.isArray(data[“canales”]) && data[“canales”].length > 0) return data[“canales”];
if (typeof data[“canal”] === “string”) return [data[“canal”]];
return [];
}

async function verificarTodosLosCanales(canales, userId) {
for (const canal of canales) {
try {
const m = await bot.getChatMember(canal, userId);
if (m.status === “left” || m.status === “kicked”) return { aprobado: false, faltante: canal };
} catch {
return { aprobado: false, faltante: canal };
}
}
return { aprobado: true, faltante: null };
}

function tasaConversion(visitas, desbloqueos) {
if (visitas === 0) return “0%”;
return `${Math.round((desbloqueos / visitas) * 100)}%`;
}

// ==========================================
// NOTIFICAR AL ADMIN
// ==========================================

async function notificarAdminPendiente(userId) {
const texto = [
“🔔 *Solicitud de acceso VIP*”,
“”,
`Un usuario quiere ser creador y está pendiente de tu aprobación.`,
`ID de Telegram: \`${userId}``,
“”,
“¿Apruebas el acceso?”,
].join(”\n”);

await bot.sendMessage(MI_ID_ADMIN, texto, {
parse_mode: “Markdown”,
reply_markup: {
inline_keyboard: [
[
{ text: “✅ Aprobar”, callback_data: `aprobar_creador_${userId}` },
{ text: “❌ Rechazar”, callback_data: `rechazar_creador_${userId}` },
],
],
},
});
}

// ==========================================
// MENÚ CREADOR
// ==========================================

const BTN_CANCELAR = [
[{ text: “❌ Cancelar proceso”, callback_data: “cancelar_creacion” }],
];

async function mostrarMenuCreador(chatId) {
await bot.sendMessage(chatId, “👤 *Menú del Creador*\n\n¿Qué deseas hacer?”, {
parse_mode: “Markdown”,
reply_markup: {
inline_keyboard: [
[{ text: “📊 Mi Estado VIP”, callback_data: “menu_status” }],
[{ text: “🔗 Mis Enlaces”, callback_data: “menu_enlaces_0” }],
[{ text: “➕ Crear Nuevo Enlace”, callback_data: “menu_crear” }],
],
},
});
}

async function mostrarStatusVip(chatId, messageId, userId) {
const doc = await db.collection(“creadores”).doc(userId.toString()).get();
if (!doc.exists) {
await bot.editMessageText(“❌ No tienes una cuenta de creador activa.”, { chat_id: chatId, message_id: messageId });
return;
}
const data = doc.data();
const activo = data[“activo”] ?? false;
const pendiente = data[“pendiente”] ?? false;
const ingreso = data[“fechaIngreso”];
const venc = data[“fechaVencimiento”];

let estadoStr = activo ? “✅ Activo” : (pendiente ? “⏳ Pendiente de aprobación” : “❌ Inactivo”);

const texto = [
“📊 *Tu Estado VIP*\n”,
`Estado: ${estadoStr}`,
`Miembro desde: ${formatearFecha(ingreso)}`,
`Vence: ${formatearFecha(venc)}`,
`${tiempoRestante(venc)}`,
].join(”\n”);

await bot.editMessageText(texto, {
chat_id: chatId, message_id: messageId, parse_mode: “Markdown”,
reply_markup: { inline_keyboard: [[{ text: “🔙 Volver al menú”, callback_data: “menu_main” }]] },
});
}

async function mostrarEnlacesCreador(chatId, messageId, userId, pagina) {
const POR_PAGINA = 4;
const rawSnap = await db.collection(“enlaces”).where(“creador”, “==”, userId).get();

const docs = rawSnap.docs.slice().sort((a, b) => {
const fa = a.data()[“fecha”]?.seconds ?? 0;
const fb = b.data()[“fecha”]?.seconds ?? 0;
return fb - fa;
});

if (docs.length === 0) {
await bot.editMessageText(
“🔗 *Mis Enlaces*\n\nNo tienes enlaces creados todavía. Usa ➕ Crear Nuevo Enlace.”,
{
chat_id: chatId, message_id: messageId, parse_mode: “Markdown”,
reply_markup: {
inline_keyboard: [
[{ text: “➕ Crear Nuevo Enlace”, callback_data: “menu_crear” }],
[{ text: “🔙 Volver al menú”, callback_data: “menu_main” }],
],
},
}
);
return;
}

const total = docs.length;
const inicio = pagina * POR_PAGINA;
const fin = Math.min(inicio + POR_PAGINA, total);
const pagActual = docs.slice(inicio, fin);

const lineas = [`🔗 *Mis Enlaces* (${total} total)\n`];
const botones = [];

for (const doc of pagActual) {
const data = doc.data();
const canales = obtenerCanales(data);
const visitas = data[“visitas”] ?? 0;
const desbloqueos = data[“desbloqueos”] ?? 0;
const tasa = tasaConversion(visitas, desbloqueos);
const fecha = data[“fecha”];
const fechaStr = fecha ? fecha.toDate().toLocaleDateString(“es-ES”) : “—”;

```
lineas.push(
  `📎 \`${doc.id}\`\n` +
  `   📢 ${canales.join(" + ")}\n` +
  `   📅 ${fechaStr}  |  👁️ ${visitas}  🔓 ${desbloqueos}  📈 ${tasa}`
);
botones.push([{ text: `🗑️ Eliminar ${doc.id}`, callback_data: `del_confirm_${doc.id}` }]);
```

}

const navRow = [];
if (pagina > 0) navRow.push({ text: “⬅️ Anterior”, callback_data: `menu_enlaces_${pagina - 1}` });
if (fin < total) navRow.push({ text: “Siguiente ➡️”, callback_data: `menu_enlaces_${pagina + 1}` });
if (navRow.length > 0) botones.push(navRow);
botones.push([{ text: “➕ Crear Nuevo Enlace”, callback_data: “menu_crear” }]);
botones.push([{ text: “🔙 Volver al menú”, callback_data: “menu_main” }]);

await bot.editMessageText(lineas.join(”\n”), {
chat_id: chatId, message_id: messageId, parse_mode: “Markdown”,
reply_markup: { inline_keyboard: botones },
});
}

function mensajeCanalesActuales(canales) {
if (canales.length === 0) {
return “⚙️ *Crear nuevo enlace*\n\nPaso 1️⃣ — *Canales requeridos*\n\nEscribe el @usuario del primer canal.\n_(El usuario debe estar en TODOS los canales para recibir el contenido)_\n\n⚠️ Agrega el bot como Administrador en cada canal.”;
}
const lista = canales.map((c, i) => `   ${i + 1}. ${c}`).join(”\n”);
return `⚙️ *Crear nuevo enlace*\n\nPaso 1️⃣ — *Canales requeridos*\n\n✅ Canales añadidos:\n${lista}\n\nEscribe otro @canal o toca *✅ Listo* para continuar.`;
}

// ==========================================
// GOD PANEL
// ==========================================

async function mostrarPanelPrincipal(chatId) {
const pendientesSnap = await db.collection(“creadores”).where(“pendiente”, “==”, true).get();
await bot.sendMessage(chatId, “🛡️ *Panel God Mode*\n\nSelecciona una opción:”, {
parse_mode: “Markdown”,
reply_markup: {
inline_keyboard: [
[{ text: `⏳ Aprobaciones pendientes (${pendientesSnap.size})`, callback_data: “panel_pendientes_0” }],
[{ text: “👥 Ver Creadores VIP”, callback_data: “panel_creadores_0” }],
[{ text: “🗝️ Generar Clave VIP”, callback_data: “panel_generar_clave” }],
],
},
});
}

async function mostrarPendientes(chatId, messageId, pagina) {
const POR_PAGINA = 5;
const snapshot = await db.collection(“creadores”).where(“pendiente”, “==”, true).get();

if (snapshot.empty) {
await bot.editMessageText(“✅ No hay solicitudes pendientes.”, {
chat_id: chatId, message_id: messageId,
reply_markup: { inline_keyboard: [[{ text: “🔙 Volver al menú”, callback_data: “panel_main” }]] },
});
return;
}

const todos = snapshot.docs;
const total = todos.length;
const inicio = pagina * POR_PAGINA;
const fin = Math.min(inicio + POR_PAGINA, total);
const pagActual = todos.slice(inicio, fin);

const lineas = [`⏳ *Solicitudes Pendientes* (${total})\n`];
const botones = [];

for (const doc of pagActual) {
const uid = doc.id;
const data = doc.data();
const ingreso = data[“fechaIngreso”];
const venc = data[“fechaVencimiento”];
lineas.push(`👤 ID: \`${uid}`\n   📅 Solicitó: ${formatearFecha(ingreso)}\n   ⏳ VIP hasta: ${formatearFecha(venc)}`); botones.push([ { text: `✅ Aprobar ${uid}`, callback_data: `aprobar_creador_${uid}`}, { text:`❌ Rechazar ${uid}`, callback_data: `rechazar_creador_${uid}` },
]);
}

const navRow = [];
if (pagina > 0) navRow.push({ text: “⬅️ Anterior”, callback_data: `panel_pendientes_${pagina - 1}` });
if (fin < total) navRow.push({ text: “Siguiente ➡️”, callback_data: `panel_pendientes_${pagina + 1}` });
if (navRow.length > 0) botones.push(navRow);
botones.push([{ text: “🔙 Volver al menú”, callback_data: “panel_main” }]);

await bot.editMessageText(lineas.join(”\n”), {
chat_id: chatId, message_id: messageId, parse_mode: “Markdown”,
reply_markup: { inline_keyboard: botones },
});
}

async function mostrarListaCreadores(chatId, messageId, pagina) {
const POR_PAGINA = 5;
const rawSnap = await db.collection(“creadores”).where(“activo”, “==”, true).get();

const docs = rawSnap.docs.slice().sort((a, b) => {
const fa = a.data()[“fechaIngreso”]?.seconds ?? 0;
const fb = b.data()[“fechaIngreso”]?.seconds ?? 0;
return fb - fa;
});

if (docs.length === 0) {
await bot.editMessageText(“👥 No hay creadores activos todavía.”, {
chat_id: chatId, message_id: messageId,
reply_markup: { inline_keyboard: [[{ text: “🔙 Volver al menú”, callback_data: “panel_main” }]] },
});
return;
}

const total = docs.length;
const inicio = pagina * POR_PAGINA;
const fin = Math.min(inicio + POR_PAGINA, total);
const pagActual = docs.slice(inicio, fin);

const lineas = [`👥 *Creadores VIP Activos* (${total})\n`];
const botones = [];

for (const doc of pagActual) {
const data = doc.data();
const uid = doc.id;
const venc = data[“fechaVencimiento”];
lineas.push(`✅ ID: \`${uid}`\n   ${tiempoRestante(venc)}`); botones.push([{ text: `👤 Gestionar ${uid}`, callback_data: `panel_creator_${uid}` }]);
}

const navRow = [];
if (pagina > 0) navRow.push({ text: “⬅️ Anterior”, callback_data: `panel_creadores_${pagina - 1}` });
if (fin < total) navRow.push({ text: “Siguiente ➡️”, callback_data: `panel_creadores_${pagina + 1}` });
if (navRow.length > 0) botones.push(navRow);
botones.push([{ text: “🔙 Volver al menú”, callback_data: “panel_main” }]);

await bot.editMessageText(lineas.join(”\n”), {
chat_id: chatId, message_id: messageId, parse_mode: “Markdown”,
reply_markup: { inline_keyboard: botones },
});
}

async function mostrarCreadorAdmin(chatId, messageId, uid) {
const doc = await db.collection(“creadores”).doc(uid).get();
if (!doc.exists) {
await bot.editMessageText(“❌ Creador no encontrado.”, { chat_id: chatId, message_id: messageId });
return;
}
const data = doc.data();
const activo = data[“activo”] ?? false;
const ingreso = data[“fechaIngreso”];
const venc = data[“fechaVencimiento”];

const texto = [
`👤 *Creador:* \`${uid}``, `📊 Estado: ${activo ? “✅ Activo” : “❌ Inactivo”}`, `📅 Ingreso: ${formatearFecha(ingreso)}`, `⏳ Vencimiento: ${formatearFecha(venc)}`,
tiempoRestante(venc),
“”,
“⏱️ *Agregar tiempo:*”,
].join(”\n”);

const botones = [
[
{ text: “+1h”, callback_data: `add_time_${uid}_1_hora` },
{ text: “+6h”, callback_data: `add_time_${uid}_6_hora` },
{ text: “+12h”, callback_data: `add_time_${uid}_12_hora` },
],
[
{ text: “+1 Día”, callback_data: `add_time_${uid}_1_dia` },
{ text: “+7 Días”, callback_data: `add_time_${uid}_7_dia` },
{ text: “+15 Días”, callback_data: `add_time_${uid}_15_dia` },
],
[
{ text: “+1 Mes”, callback_data: `add_time_${uid}_30_dia` },
{ text: “+3 Meses”, callback_data: `add_time_${uid}_90_dia` },
{ text: “+1 Año”, callback_data: `add_time_${uid}_365_dia` },
],
[
activo
? { text: “🚫 Desactivar VIP”, callback_data: `toggle_creator_${uid}_false` }
: { text: “✅ Reactivar VIP”, callback_data: `toggle_creator_${uid}_true` },
],
[{ text: “🔙 Volver a la lista”, callback_data: “panel_creadores_0” }],
];

await bot.editMessageText(texto, {
chat_id: chatId, message_id: messageId, parse_mode: “Markdown”,
reply_markup: { inline_keyboard: botones },
});
}

// ==========================================
// MENSAJES ENTRANTES
// ==========================================
bot.on(“message”, async (msg) => {
const chatId = msg.chat.id;
const texto = msg.text ?? “”;
const userId = msg.from?.id;
if (!userId) return;

if (texto === PALABRA_MAGICA) {
if (userId !== MI_ID_ADMIN) return void bot.sendMessage(chatId, “⛔ Comando no autorizado.”);
return void mostrarPanelPrincipal(chatId);
}

if (texto.startsWith(”/start “)) {
const payload = texto.split(” “)[1];
try {
const snap = await db.collection(“enlaces”).doc(payload).get();
if (!snap.exists) return void bot.sendMessage(chatId, “❌ El enlace es inválido o ya no existe.”);

```
  const datos = snap.data();
  const canales = obtenerCanales(datos);
  const contenido = datos["contenido"];

  await db.collection("enlaces").doc(payload).update({
    visitas: firebaseAdmin.firestore.FieldValue.increment(1),
  });

  const { aprobado, faltante } = await verificarTodosLosCanales(canales, userId);

  if (!aprobado && faltante) {
    const botonesCanales = canales.map((c) => [
      { text: `📢 Suscribirse a ${c}`, url: `https://t.me/${c.replace("@", "")}` },
    ]);
    botonesCanales.push([{ text: "✅ Ya me suscribí a todos (Verificar)", callback_data: `check_${payload}` }]);
    const textoLock = canales.length > 1
      ? `🔒 *Contenido Bloqueado*\n\nDebes suscribirte a los *${canales.length} canales* para acceder:`
      : "🔒 *Contenido Bloqueado*\n\nPara acceder, debes suscribirte al canal oficial.";
    return void bot.sendMessage(chatId, textoLock, {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: botonesCanales },
    });
  }

  await db.collection("enlaces").doc(payload).update({
    desbloqueos: firebaseAdmin.firestore.FieldValue.increment(1),
  });

  return void bot.sendMessage(chatId, `🎉 *¡Verificación exitosa!*\n\nAquí tienes tu contenido:\n\n${contenido}`, {
    parse_mode: "Markdown",
  });
} catch (error) {
  console.error("Error en deep link:", error);
  return void bot.sendMessage(chatId, "❌ Hubo un error al verificar. Intenta de nuevo.");
}
```

}

if (texto === “/start”) {
return void bot.sendMessage(
chatId,
“👋 ¡Hola! Soy el sistema de verificación de enlaces.\n\n🔒 Este bot es de acceso privado.\n\n• Si tienes una Clave Única: `/activar TU_CLAVE`\n• Si ya tienes acceso: `/menu`”,
{ parse_mode: “Markdown” }
);
}

if (texto === “/menu”) {
const vigente = await estaVigente(userId);
if (!vigente) {
const doc = await db.collection(“creadores”).doc(userId.toString()).get();
if (doc.exists && doc.data()?.[“pendiente”]) {
return void bot.sendMessage(chatId,
“⏳ *Tu solicitud está pendiente de aprobación.*\n\nEl administrador revisará tu acceso pronto.”,
{ parse_mode: “Markdown” }
);
}
return void bot.sendMessage(chatId,
“🔒 *Acceso Denegado*\n\nNecesitas una Clave VIP activa o tu membresía venció.”,
{ parse_mode: “Markdown” }
);
}
return void mostrarMenuCreador(chatId);
}

if (texto === “/generar_clave”) {
if (userId !== MI_ID_ADMIN) return void bot.sendMessage(chatId, “⛔ Comando no autorizado.”);
const nuevaClave = “VIP-” + Math.random().toString(36).substring(2, 8).toUpperCase();
try {
await db.collection(“claves”).doc(nuevaClave).set({
usada: false,
fechaCreacion: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
});
return void bot.sendMessage(chatId,
`🗝️ *Clave generada:*\n\n\`${nuevaClave}`\n\nEl receptor tendrá *30 días VIP* pendientes de tu aprobación.`,
{ parse_mode: “Markdown” }
);
} catch (error) {
console.error(“Error generando clave:”, error);
return void bot.sendMessage(chatId, “❌ Error al generar la clave.”);
}
}

if (texto.startsWith(”/activar “)) {
const clave = texto.split(” “)[1];
try {
const claveRef = db.collection(“claves”).doc(clave);
const claveDoc = await claveRef.get();
if (!claveDoc.exists) return void bot.sendMessage(chatId, “❌ La clave no existe.”);
if (claveDoc.data()?.[“usada”]) return void bot.sendMessage(chatId, “❌ Esta clave ya fue utilizada.”);

```
  const fechaVenc = fechaVencimientoDefault();
  await claveRef.update({ usada: true, usadaPor: userId });

  await db.collection("creadores").doc(userId.toString()).set({
    activo: false,
    pendiente: true,
    fechaIngreso: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
    fechaVencimiento: firebaseAdmin.firestore.Timestamp.fromDate(fechaVenc),
  });

  await notificarAdminPendiente(userId);

  return void bot.sendMessage(chatId,
    `✅ *¡Clave válida!*\n\nTu solicitud fue enviada al administrador.\nTe notificaré cuando esté activa.`,
    { parse_mode: "Markdown" }
  );
} catch (error) {
  console.error("Error activando clave:", error);
  return void bot.sendMessage(chatId, "❌ Error al procesar la clave.");
}
```

}

if (texto === “/cancelar”) {
if (estadosCreacion[chatId]) {
delete estadosCreacion[chatId];
return void bot.sendMessage(chatId, “✅ Proceso cancelado. Escribe /menu para volver.”);
}
return void bot.sendMessage(chatId, “No hay ningún proceso activo que cancelar.”);
}

if (estadosCreacion[chatId] && estadosCreacion[chatId].paso === 1) {
const estado = estadosCreacion[chatId];
if (!texto.startsWith(”@”)) {
return void bot.sendMessage(chatId, “❌ El canal debe comenzar con @ (Ejemplo: @MiCanalVIP)”, {
reply_markup: { inline_keyboard: BTN_CANCELAR },
});
}
if (estado.canales.includes(texto)) {
return void bot.sendMessage(chatId, `⚠️ El canal ${texto} ya está en la lista.`, {
reply_markup: { inline_keyboard: BTN_CANCELAR },
});
}
estado.canales.push(texto);
return void bot.sendMessage(chatId, mensajeCanalesActuales(estado.canales), {
parse_mode: “Markdown”,
reply_markup: {
inline_keyboard: [
[{ text: “✅ Listo, agregar contenido”, callback_data: “canales_listo” }],
…BTN_CANCELAR,
],
},
});
}
});

// ==========================================
// CALLBACKS
// ==========================================
bot.on(“callback_query”, async (query) => {
const chatId = query.message?.chat.id;
const messageId = query.message?.message_id;
const userId = query.from.id;
const data = query.data ?? “”;
if (!chatId || !messageId) return;

void bot.answerCallbackQuery(query.id);

if (data === “cancelar_creacion”) {
if (estadosCreacion[chatId]) delete estadosCreacion[chatId];
await bot.editMessageText(“✅ Proceso cancelado. Escribe /menu para volver.”, { chat_id: chatId, message_id: messageId });
return;
}

if (data === “menu_main”) {
await bot.editMessageText(“👤 *Menú del Creador*\n\n¿Qué deseas hacer?”, {
chat_id: chatId, message_id: messageId, parse_mode: “Markdown”,
reply_markup: {
inline_keyboard: [
[{ text: “📊 Mi Estado VIP”, callback_data: “menu_status” }],
[{ text: “🔗 Mis Enlaces”, callback_data: “menu_enlaces_0” }],
[{ text: “➕ Crear Nuevo Enlace”, callback_data: “menu_crear” }],
],
},
});
return;
}

if (data === “menu_status”) { await mostrarStatusVip(chatId, messageId, userId); return; }

if (data.startsWith(“menu_enlaces_”)) {
const pagina = parseInt(data.replace(“menu_enlaces_”, “”)) || 0;
await mostrarEnlacesCreador(chatId, messageId, userId, pagina);
return;
}

if (data === “menu_crear”) {
const vigente = await estaVigente(userId);
if (!vigente) {
await bot.editMessageText(“🔒 Tu VIP venció o no tienes acceso activo.”, { chat_id: chatId, message_id: messageId });
return;
}
estadosCreacion[chatId] = { paso: 1, canales: [] };
await bot.editMessageText(mensajeCanalesActuales([]), {
chat_id: chatId, message_id: messageId, parse_mode: “Markdown”,
reply_markup: { inline_keyboard: BTN_CANCELAR },
});
return;
}

if (data === “canales_listo”) {
const estado = estadosCreacion[chatId];
if (!estado || estado.canales.length === 0) {
await bot.editMessageText(“⚠️ Debes agregar al menos un canal antes de continuar.”, {
chat_id: chatId, message_id: messageId,
reply_markup: { inline_keyboard: BTN_CANCELAR },
});
return;
}
estado.paso = 2;
const lista = estado.canales.map((c, i) => `   ${i + 1}. ${c}`).join(”\n”);
await bot.editMessageText(
`✅ *Canales configurados:*\n${lista}\n\nPaso 2️⃣ — Escribe el contenido que recibirán al suscribirse.\n_(Link, contraseña, texto, etc.)_`,
{
chat_id: chatId, message_id: messageId, parse_mode: “Markdown”,
reply_markup: { inline_keyboard: BTN_CANCELAR },
}
);

```
const onceHandler = async (msg) => {
  if (msg.chat.id !== chatId) return;
  if (!estadosCreacion[chatId] || estadosCreacion[chatId].paso !== 2) return;
  const contenido = msg.text ?? "";
  if (!contenido) return;

  bot.removeListener("message", onceHandler);
  const canalesGuardados = [...estadosCreacion[chatId].canales];
  delete estadosCreacion[chatId];

  const idUnico = "prod_" + Date.now();
  try {
    await db.collection("enlaces").doc(idUnico).set({
      canales: canalesGuardados,
      canal: canalesGuardados[0],
      contenido,
      creador: userId,
      visitas: 0,
      desbloqueos: 0,
      fecha: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
    });
    const infoBot = await bot.getMe();
    const enlace = `https://t.me/${infoBot.username}?start=${idUnico}`;
    const listaStr = canalesGuardados.map((c, i) => `   ${i + 1}. ${c}`).join("\n");
    await bot.sendMessage(chatId,
      `🚀 *¡Enlace protegido creado!*\n\n🔗 Comparte este enlace:\n\`${enlace}\`\n\n📢 Canales requeridos:\n${listaStr}`,
      { parse_mode: "Markdown" }
    );
  } catch (error) {
    console.error("Error guardando enlace:", error);
    await bot.sendMessage(chatId, "❌ Error al guardar el enlace. Intenta de nuevo.");
  }
};
bot.on("message", onceHandler);
return;
```

}

if (data.startsWith(“del_confirm_”)) {
const id = data.replace(“del_confirm_”, “”);
await bot.editMessageText(`🗑️ *¿Eliminar este enlace?*\n\nID: \`${id}`\n\nEsta acción es irreversible.`, { chat_id: chatId, message_id: messageId, parse_mode: "Markdown", reply_markup: { inline_keyboard: [[ { text: "✅ Sí, eliminar", callback_data: `del_ok_${id}` },
{ text: “❌ Cancelar”, callback_data: “menu_enlaces_0” },
]],
},
});
return;
}

if (data.startsWith(“del_ok_”)) {
const id = data.replace(“del_ok_”, “”);
try {
const doc = await db.collection(“enlaces”).doc(id).get();
if (doc.exists && doc.data()?.[“creador”] === userId) {
await db.collection(“enlaces”).doc(id).delete();
await bot.editMessageText(`✅ Enlace \`${id}` eliminado correctamente.`, {
chat_id: chatId, message_id: messageId, parse_mode: “Markdown”,
reply_markup: {
inline_keyboard: [
[{ text: “🔗 Ver mis enlaces”, callback_data: “menu_enlaces_0” }],
[{ text: “🔙 Menú”, callback_data: “menu_main” }],
],
},
});
} else {
await bot.editMessageText(“❌ No tienes permiso para eliminar este enlace.”, { chat_id: chatId, message_id: messageId });
}
} catch (error) {
console.error(“Error eliminando enlace:”, error);
}
return;
}

if (data.startsWith(“check_”)) {
const payload = data.replace(“check_”, “”);
try {
const snap = await db.collection(“enlaces”).doc(payload).get();
if (!snap.exists) return;
const datos = snap.data();
const canales = obtenerCanales(datos);
const contenido = datos[“contenido”];
const { aprobado, faltante } = await verificarTodosLosCanales(canales, userId);
if (!aprobado) {
void bot.answerCallbackQuery(query.id, { text: `❌ Aún no estás en ${faltante ?? "todos los canales"}.`, show_alert: true });
} else {
await db.collection(“enlaces”).doc(payload).update({
desbloqueos: firebaseAdmin.firestore.FieldValue.increment(1),
});
void bot.editMessageText(`🎉 *¡Verificación exitosa!*\n\nAquí tienes tu contenido:\n\n${contenido}`, {
chat_id: chatId, message_id: messageId, parse_mode: “Markdown”
});
}
} catch (error) {
console.error(“Error en check:”, error);
void bot.answerCallbackQuery(query.id, { text: “❌ Error de verificación.”, show_alert: true });
}
return;
}

if (data.startsWith(“aprobar_creador_”)) {
if (userId !== MI_ID_ADMIN) return;
const uid = data.replace(“aprobar_creador_”, “”);
try {
await db.collection(“creadores”).doc(uid).update({ activo: true, pendiente: false });
await bot.editMessageText(`✅ *Creador \`${uid}` aprobado.*`, { chat_id: chatId, message_id: messageId, parse_mode: “Markdown” });
await bot.sendMessage(parseInt(uid), “🎉 *¡Tu acceso VIP fue aprobado!*\n\nYa puedes usar /menu.”, { parse_mode: “Markdown” });
} catch (error) { console.error(“Error aprobando:”, error); }
return;
}

if (data.startsWith(“rechazar_creador_”)) {
if (userId !== MI_ID_ADMIN) return;
const uid = data.replace(“rechazar_creador_”, “”);
try {
await db.collection(“creadores”).doc(uid).update({ activo: false, pendiente: false });
await bot.editMessageText(`❌ *Creador \`${uid}` rechazado.*`, { chat_id: chatId, message_id: messageId, parse_mode: “Markdown” });
await bot.sendMessage(parseInt(uid), “❌ *Tu solicitud fue rechazada.*\n\nContacta al administrador.”, { parse_mode: “Markdown” });
} catch (error) { console.error(“Error rechazando:”, error); }
return;
}

if (userId !== MI_ID_ADMIN) return;

if (data === “panel_main”) {
const pendientesSnap = await db.collection(“creadores”).where(“pendiente”, “==”, true).get();
await bot.editMessageText(“🛡️ *Panel God Mode*\n\nSelecciona una opción:”, {
chat_id: chatId, message_id: messageId, parse_mode: “Markdown”,
reply_markup: {
inline_keyboard: [
[{ text: `⏳ Aprobaciones pendientes (${pendientesSnap.size})`, callback_data: “panel_pendientes_0” }],
[{ text: “👥 Ver Creadores VIP”, callback_data: “panel_creadores_0” }],
[{ text: “🗝️ Generar Clave VIP”, callback_data: “panel_generar_clave” }],
],
},
});
return;
}

if (data.startsWith(“panel_pendientes_”)) {
const pagina = parseInt(data.replace(“panel_pendientes_”, “”)) || 0;
await mostrarPendientes(chatId, messageId, pagina);
return;
}

if (data.startsWith(“panel_creadores_”)) {
const pagina = parseInt(data.replace(“panel_creadores_”, “”)) || 0;
await mostrarListaCreadores(chatId, messageId, pagina);
return;
}

if (data.startsWith(“panel_creator_”)) {
const uid = data.replace(“panel_creator_”, “”);
await mostrarCreadorAdmin(chatId, messageId, uid);
return;
}

if (data === “panel_generar_clave”) {
const nuevaClave = “VIP-” + Math.random().toString(36).substring(2, 8).toUpperCase();
try {
await db.collection(“claves”).doc(nuevaClave).set({
usada: false,
fechaCreacion: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
});
await bot.editMessageText(
`🗝️ *Clave generada:*\n\n\`${nuevaClave}`\n\nEl receptor tendrá *30 días VIP* pendientes de tu aprobación.`,
{
chat_id: chatId, message_id: messageId, parse_mode: “Markdown”,
reply_markup: { inline_keyboard: [[{ text: “🔙 Volver al menú”, callback_data: “panel_main” }]] },
}
);
} catch (error) { console.error(“Error generando clave:”, error); }
return;
}

if (data.startsWith(“add_time_”)) {
const partes = data.split(”*”);
const unidad = partes[partes.length - 1];
const cantidad = parseInt(partes[partes.length - 2]);
const uid = partes.slice(2, partes.length - 2).join(”*”);
try {
const ref = db.collection(“creadores”).doc(uid);
const doc = await ref.get();
if (!doc.exists) return;
const venc = doc.data()?.[“fechaVencimiento”];
const base = venc && venc.toDate() > new Date() ? venc.toDate() : new Date();
const nuevaFecha = new Date(base);
if (unidad === “hora”) nuevaFecha.setHours(nuevaFecha.getHours() + cantidad);
else nuevaFecha.setDate(nuevaFecha.getDate() + cantidad);
await ref.update({ activo: true, fechaVencimiento: firebaseAdmin.firestore.Timestamp.fromDate(nuevaFecha) });
await mostrarCreadorAdmin(chatId, messageId, uid);
} catch (error) { console.error(“Error agregando tiempo:”, error); }
return;
}

if (data.startsWith(“toggle_creator_”)) {
const partes = data.split(”*”);
const nuevoEstado = partes[partes.length - 1] === “true”;
const uid = partes.slice(2, partes.length - 1).join(”*”);
try {
await db.collection(“creadores”).doc(uid).update({ activo: nuevoEstado });
await mostrarCreadorAdmin(chatId, messageId, uid);
} catch (error) { console.error(“Error cambiando estado:”, error); }
return;
}
});

// ==========================================
// ERRORES
// ==========================================
bot.on(“polling_error”, (error) => {
console.error(“Error de polling:”, error);
});

process.on(“unhandledRejection”, (reason) => {
const msg = reason instanceof Error ? reason.message : String(reason);
if (
msg.includes(“message is not modified”) ||
msg.includes(“message to delete not found”) ||
msg.includes(“query is too old”) ||
msg.includes(“ETELEGRAM”)
) return;
console.error(“Unhandled rejection:”, reason);
});
