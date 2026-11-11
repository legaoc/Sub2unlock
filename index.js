import TelegramBot from "node-telegram-bot-api";
import { db, firebaseAdmin } from "./firebase.js";
import { t } from "./lang.js";
import XLSX from "xlsx";

const TOKEN = process.env["TOKEN"];
const MI_ID_ADMIN = parseInt(process.env["MI_ID_ADMIN"] ?? "0");
const PALABRA_MAGICA = "/panel";

if (!TOKEN) throw new Error("TOKEN environment variable is required.");
if (!MI_ID_ADMIN) throw new Error("MI_ID_ADMIN environment variable is required.");

const bot = new TelegramBot(TOKEN, { polling: true });

const COMANDOS_MENU = [
{ command: "start", description: "Iniciar el bot y elegir idioma" },
{ command: "menu", description: "Mi panel de creador" },
{ command: "activar", description: "Canjear una clave VIP" },
{ command: "idioma", description: "Cambiar idioma" },
{ command: "cancelar", description: "Cancelar la creación de un enlace" },
];
bot.setMyCommands(COMANDOS_MENU).catch((e) => console.error("Error al poner comandos:", e.message));
bot.setMyCommands(COMANDOS_MENU, { language_code: "es" }).catch((e) => console.error("Error al poner comandos es:", e.message));
const estadosCreacion = {};

const estadosSoporte = {};
const estadosCaptcha = {};
const estadosCanal = {};
const DIAS_POR_REFERIDO = 3;
const MINUTOS_AUTOBORRADO = 5;

function nombreUsuario(from) {
return from?.username ? `@${from.username}` : (from?.first_name ?? "usuario");
}

async function registrarDesbloqueo(enlaceId, datos, userId, from) {
try {
const nombre = nombreUsuario(from);
await db.collection("desbloqueos").add({
enlaceId, creador: datos["creador"], userId, nombre,
fecha: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
});
const total = (datos["desbloqueos"] ?? 0) + 1;
try {
await bot.sendMessage(datos["creador"], t(await getLang(datos["creador"]), "unlock_notify", nombre, enlaceId, total), { parse_mode: "Markdown" });
} catch (e) {}
} catch (error) { console.error("Error al registrar desbloqueo:", error); }
}

function enlaceBloqueado(datos) {
const ahora = new Date();
const expira = datos["expiraEl"];
if (expira && expira.toDate() <= ahora) return "expired";
const limite = datos["limiteUsos"];
if (typeof limite === "number" && limite > 0 && (datos["desbloqueos"] ?? 0) >= limite) return "limit";
return null;
}

async function guardarEnlace(chatId, userId, estado, limite) {
const canalesGuardados = [...estado.canales];
const hLang = estado.lang ?? "es";
const idUnico = "prod_" + Date.now();
const docData = {
canales: canalesGuardados, canal: canalesGuardados[0], contenido: estado.contenido,
creador: userId, visitas: 0, desbloqueos: 0,
fecha: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
};
let limiteTxt = t(hLang, "limit_none");
if (limite && limite.tipo === "exp") {
docData["expiraEl"] = firebaseAdmin.firestore.Timestamp.fromDate(new Date(Date.now() + limite.dias * 24 * 60 * 60 * 1000));
limiteTxt = limite.dias === 1 ? t(hLang, "limit_exp_1d") : (limite.dias === 7 ? t(hLang, "limit_exp_7d") : t(hLang, "limit_exp_30d"));
} else if (limite && limite.tipo === "uses") {
docData["limiteUsos"] = limite.usos;
limiteTxt = limite.usos === 10 ? t(hLang, "limit_uses_10") : (limite.usos === 50 ? t(hLang, "limit_uses_50") : t(hLang, "limit_uses_100"));
}
try {
await db.collection("enlaces").doc(idUnico).set(docData);
const infoBot = await bot.getMe();
const enlace = `https://t.me/${infoBot.username}?start=${idUnico}`;
const listaStr = canalesGuardados.map((c, i) => `   ${i + 1}. ${c}`).join("\n");
await bot.sendMessage(chatId, t(hLang, "create_success", enlace, listaStr, limiteTxt), { parse_mode: "Markdown" });
} catch (error) {
console.error(error);
await bot.sendMessage(chatId, t(hLang, "create_error"));
}
}
const langCache = {};

console.log("Sub2Unlock Bot iniciado.");

async function getLang(userId) {
if (langCache[userId]) return langCache[userId];
try {
const doc = await db.collection("usuarios").doc(userId.toString()).get();
const lang = doc.exists ? (doc.data()["lang"] ?? "es") : "es";
langCache[userId] = lang;
return lang;
} catch { return "es"; }
}

async function setLang(userId, lang) {
langCache[userId] = lang;
await db.collection("usuarios").doc(userId.toString()).set({ lang }, { merge: true });
}

function fechaVencimientoDefault() {
const f = new Date();
f.setDate(f.getDate() + 30);
return f;
}

function formatearFecha(ts, lang) {
if (!ts) return t(lang, "no_date");
return ts.toDate().toLocaleDateString(lang === "en" ? "en-US" : "es-ES", {
day: "2-digit", month: "2-digit", year: "numeric",
hour: "2-digit", minute: "2-digit",
});
}

function tiempoRestante(ts, lang) {
if (!ts) return t(lang, "time_unknown");
const diff = ts.toDate().getTime() - Date.now();
if (diff <= 0) return t(lang, "time_expired");
const dias = Math.floor(diff / 86400000);
const horas = Math.floor((diff % 86400000) / 3600000);
if (dias > 0) return t(lang, "time_days", dias, horas);
return t(lang, "time_hours", horas);
}

async function estaVigente(userId) {
if (userId === MI_ID_ADMIN) return true;
const doc = await db.collection("creadores").doc(userId.toString()).get();
if (!doc.exists) return false;
const data = doc.data();
if (!data["activo"]) return false;
const venc = data["fechaVencimiento"];
return !!venc && venc.toDate() > new Date();
}

function obtenerCanales(data) {
if (Array.isArray(data["canales"]) && data["canales"].length > 0) return data["canales"];
if (typeof data["canal"] === "string") return [data["canal"]];
return [];
}

async function verificarTodosLosCanales(canales, userId) {
for (const canal of canales) {
try {
const m = await bot.getChatMember(canal, userId);
if (m.status === "left" || m.status === "kicked") return { aprobado: false, faltante: canal };
} catch { return { aprobado: false, faltante: canal }; }
}
return { aprobado: true, faltante: null };
}

function tasaConversion(visitas, desbloqueos) {
if (visitas === 0) return "0%";
return `${Math.round((desbloqueos / visitas) * 100)}%`;
}

async function notificarAdminPendiente(userId) {
const lang = await getLang(MI_ID_ADMIN);
await bot.sendMessage(MI_ID_ADMIN, t(lang, "admin_notify", userId), {
parse_mode: "Markdown",
reply_markup: {
inline_keyboard: [[
{ text: t(lang, "approve_btn_admin"), callback_data: `aprobar_creador_${userId}` },
{ text: t(lang, "reject_btn_admin"), callback_data: `rechazar_creador_${userId}` },
]],
},
});
}


async function getCanalesObligatorios() {
try {
const doc = await db.collection("config").doc("global").get();
if (!doc.exists) return [];
const data = doc.data() ?? {};
if (Array.isArray(data["canalesObligatorios"])) return data["canalesObligatorios"];
if (data["canalNoticias"]) return [data["canalNoticias"]];
return [];
} catch (error) { console.error(error); return []; }
}

async function enMantenimiento() {
try {
const doc = await db.collection("config").doc("mantenimiento").get();
return doc.exists ? (doc.data()?.["activo"] ?? false) : false;
} catch (error) { console.error(error); return false; }
}

async function verificarCanalGlobal(userId) {
const canales = await getCanalesObligatorios();
if (canales.length === 0) return { ok: true, canal: "", faltantes: [] };
const faltantes = [];
for (const canal of canales) {
try {
const miembro = await bot.getChatMember(canal, userId);
const estado = miembro?.status;
if (!(estado === "member" || estado === "administrator" || estado === "creator")) faltantes.push(canal);
} catch (error) {}
}
return { ok: faltantes.length === 0, canal: faltantes[0] ?? "", faltantes };
}

async function exigeCanalGlobal(chatId, userId, lang) {
const { ok, faltantes } = await verificarCanalGlobal(userId);
if (ok) return true;
const lista = faltantes.join(", ");
const botones = faltantes.map((c) => [{ text: t(lang, "global_join_btn", c), url: `https://t.me/${c.replace("@", "")}` }]);
botones.push([{ text: t(lang, "global_verify_btn"), callback_data: "check_global" }]);
await bot.sendMessage(chatId, t(lang, "global_gate", lista), {
parse_mode: "Markdown",
reply_markup: { inline_keyboard: botones },
});
return false;
}

function programarAutoborrado(chatId, messageId) {
setTimeout(() => { bot.deleteMessage(chatId, messageId).catch(() => {}); }, MINUTOS_AUTOBORRADO * 60 * 1000);
}

async function enviarCaptcha(chatId, payload, lang) {
const a = 2 + Math.floor(Math.random() * 8);
const b = 2 + Math.floor(Math.random() * 8);
const correcta = a + b;
const opciones = new Set([correcta]);
while (opciones.size < 4) {
const c = correcta + Math.floor(Math.random() * 11) - 5;
if (c > 0) opciones.add(c);
}
const lista = [...opciones].sort(() => Math.random() - 0.5);
estadosCaptcha[chatId] = { payload, correcta };
await bot.sendMessage(chatId, t(lang, "captcha_ask", a, b), {
parse_mode: "Markdown",
reply_markup: { inline_keyboard: [lista.map((v) => ({ text: String(v), callback_data: `captcha_${payload}_${v}` }))] },
});
}

async function procesarDeepLink(chatId, userId, payload, lang, from) {
try {
const snap = await db.collection("enlaces").doc(payload).get();
if (!snap.exists) return void bot.sendMessage(chatId, t(lang, "invalid_link"));
const datos = snap.data();
const bloqueo = enlaceBloqueado(datos);
if (bloqueo === "expired") return void bot.sendMessage(chatId, t(lang, "link_expired"));
if (bloqueo === "limit") return void bot.sendMessage(chatId, t(lang, "link_limit"));
const canales = obtenerCanales(datos);
const contenido = datos["contenido"];
await db.collection("enlaces").doc(payload).update({ visitas: firebaseAdmin.firestore.FieldValue.increment(1) });
const { aprobado, faltante } = await verificarTodosLosCanales(canales, userId);
if (!aprobado && faltante) {
const botonesCanales = canales.map((c) => [{ text: t(lang, "subscribe_btn", c), url: `https://t.me/${c.replace("@", "")}` }]);
botonesCanales.push([{ text: t(lang, "verify_btn"), callback_data: `check_${payload}` }]);
return void bot.sendMessage(chatId, canales.length > 1 ? t(lang, "content_locked_multi", canales.length) : t(lang, "content_locked_single"), {
parse_mode: "Markdown", reply_markup: { inline_keyboard: botonesCanales },
});
}
await db.collection("enlaces").doc(payload).update({ desbloqueos: firebaseAdmin.firestore.FieldValue.increment(1) });
await registrarDesbloqueo(payload, datos, userId, from);
const enviado = await bot.sendMessage(chatId, t(lang, "verify_success", contenido) + t(lang, "content_selfdestruct"), { parse_mode: "Markdown" });
programarAutoborrado(chatId, enviado.message_id);
return;
} catch (error) {
console.error("Error en deep link:", error);
return void bot.sendMessage(chatId, t(lang, "error_generic"));
}
}

async function mostrarMenuCreador(chatId, lang) {
await bot.sendMessage(chatId, t(lang, "menu_title"), {
parse_mode: "Markdown",
reply_markup: {
inline_keyboard: [
[{ text: t(lang, "menu_status"), callback_data: "menu_status" }],
[{ text: t(lang, "menu_links"), callback_data: "menu_enlaces_0" }],
[{ text: t(lang, "menu_create"), callback_data: "menu_crear" }],
[{ text: t(lang, "menu_stats"), callback_data: "menu_stats" }],
[{ text: t(lang, "menu_referidos"), callback_data: "menu_referidos" }],
[{ text: t(lang, "menu_support"), callback_data: "soporte" }],
],
},
});
}

async function mostrarStatusVip(chatId, messageId, userId, lang) {
const doc = await db.collection("creadores").doc(userId.toString()).get();
if (!doc.exists) {
await bot.editMessageText(t(lang, "access_denied"), { chat_id: chatId, message_id: messageId });
return;
}
const data = doc.data();
const activo = data["activo"] ?? false;
const pendiente = data["pendiente"] ?? false;
const estadoStr = activo ? t(lang, "status_active") : (pendiente ? t(lang, "status_pending_label") : t(lang, "status_inactive"));
const texto = [
t(lang, "status_title"),
`Estado: ${estadoStr}`,
`${t(lang, "status_member_since")} ${formatearFecha(data["fechaIngreso"], lang)}`,
`${t(lang, "status_expires")} ${formatearFecha(data["fechaVencimiento"], lang)}`,
tiempoRestante(data["fechaVencimiento"], lang),
].join("\n");
await bot.editMessageText(texto, {
chat_id: chatId, message_id: messageId, parse_mode: "Markdown",
reply_markup: { inline_keyboard: [[{ text: t(lang, "menu_back"), callback_data: "menu_main" }]] },
});
}

async function mostrarEnlacesCreador(chatId, messageId, userId, pagina, lang) {
const POR_PAGINA = 4;
const rawSnap = await db.collection("enlaces").where("creador", "==", userId).get();
const docs = rawSnap.docs.slice().sort((a, b) => {
return (b.data()["fecha"]?.seconds ?? 0) - (a.data()["fecha"]?.seconds ?? 0);
});

if (docs.length === 0) {
await bot.editMessageText(t(lang, "no_links"), {
chat_id: chatId, message_id: messageId, parse_mode: "Markdown",
reply_markup: { inline_keyboard: [
[{ text: t(lang, "menu_create"), callback_data: "menu_crear" }],
[{ text: t(lang, "menu_back"), callback_data: "menu_main" }],
]},
});
return;
}

const total = docs.length;
const inicio = pagina * POR_PAGINA;
const fin = Math.min(inicio + POR_PAGINA, total);
const lineas = [t(lang, "links_title", total)];
const botones = [];

for (const doc of docs.slice(inicio, fin)) {
const data = doc.data();
const canales = obtenerCanales(data);
const visitas = data["visitas"] ?? 0;
const desbloqueos = data["desbloqueos"] ?? 0;
const fechaStr = data["fecha"] ? data["fecha"].toDate().toLocaleDateString(lang === "en" ? "en-US" : "es-ES") : "–";
lineas.push(`/link\`${doc.id}\`\n   ${canales.join(" + ")}\n   ${fechaStr} | v:${visitas} d:${desbloqueos} (${tasaConversion(visitas, desbloqueos)})`); botones.push([{ text: "📊", callback_data: `stats_${doc.id}` }, { text: t(lang, "delete_btn", doc.id), callback_data: `del_confirm_${doc.id}` }]);
}

const navRow = [];
if (pagina > 0) navRow.push({ text: t(lang, "prev"), callback_data: `menu_enlaces_${pagina - 1}` });
if (fin < total) navRow.push({ text: t(lang, "next"), callback_data: `menu_enlaces_${pagina + 1}` });
if (navRow.length > 0) botones.push(navRow);
botones.push([{ text: t(lang, "menu_create"), callback_data: "menu_crear" }]);
botones.push([{ text: t(lang, "menu_back"), callback_data: "menu_main" }]);

await bot.editMessageText(lineas.join("\n"), {
chat_id: chatId, message_id: messageId, parse_mode: "Markdown",
reply_markup: { inline_keyboard: botones },
});
}

async function mostrarPanelPrincipal(chatId) {
const lang = await getLang(MI_ID_ADMIN);
const snap = await db.collection("creadores").where("pendiente", "==", true).get();
await bot.sendMessage(chatId, t(lang, "panel_title"), {
parse_mode: "Markdown",
reply_markup: { inline_keyboard: [
[{ text: t(lang, "panel_pending_btn", snap.size), callback_data: "panel_pendientes_0" }],
[{ text: t(lang, "panel_creators_btn"), callback_data: "panel_creadores_0" }],
[{ text: t(lang, "panel_gen_key_btn"), callback_data: "panel_generar_clave" }],
[{ text: t(lang, "panel_stats_btn"), callback_data: "panel_stats" }],
[{ text: t(lang, "panel_export_btn"), callback_data: "panel_export" }],
[{ text: t(lang, "panel_canal_btn"), callback_data: "panel_canal" }],
[{ text: t(lang, (await enMantenimiento()) ? "panel_maint_btn_on" : "panel_maint_btn_off"), callback_data: "panel_mantenimiento" }],
]},
});
}

async function mostrarPendientes(chatId, messageId, pagina) {
const lang = await getLang(MI_ID_ADMIN);
const POR_PAGINA = 5;
const snapshot = await db.collection("creadores").where("pendiente", "==", true).get();
if (snapshot.empty) {
await bot.editMessageText(t(lang, "pending_none"), {
chat_id: chatId, message_id: messageId,
reply_markup: { inline_keyboard: [[{ text: t(lang, "menu_back"), callback_data: "panel_main" }]] },
});
return;
}
const todos = snapshot.docs;
const inicio = pagina * POR_PAGINA;
const fin = Math.min(inicio + POR_PAGINA, todos.length);
const lineas = [t(lang, "pending_title", todos.length)];
const botones = [];
for (const doc of todos.slice(inicio, fin)) {
const uid = doc.id;
const data = doc.data();
lineas.push(`ID: \`${uid}\`\n   ${formatearFecha(data["fechaIngreso"], lang)}`); botones.push([ { text: t(lang, "approve_btn", uid), callback_data: `aprobar_creador_${uid}`}, { text: t(lang, "reject_btn", uid), callback_data:`rechazar_creador_${uid}`}, ]); } const navRow = []; if (pagina > 0) navRow.push({ text: t(lang, "prev"), callback_data:`panel_pendientes_${pagina - 1}`}); if (fin < todos.length) navRow.push({ text: t(lang, "next"), callback_data:`panel_pendientes_${pagina + 1}` });
if (navRow.length > 0) botones.push(navRow);
botones.push([{ text: t(lang, "menu_back"), callback_data: "panel_main" }]);
await bot.editMessageText(lineas.join("\n"), {
chat_id: chatId, message_id: messageId, parse_mode: "Markdown",
reply_markup: { inline_keyboard: botones },
});
}

async function mostrarListaCreadores(chatId, messageId, pagina) {
const lang = await getLang(MI_ID_ADMIN);
const POR_PAGINA = 5;
const rawSnap = await db.collection("creadores").where("activo", "==", true).get();
const docs = rawSnap.docs.slice().sort((a, b) => {
return (b.data()["fechaIngreso"]?.seconds ?? 0) - (a.data()["fechaIngreso"]?.seconds ?? 0);
});
if (docs.length === 0) {
await bot.editMessageText(t(lang, "creators_none"), {
chat_id: chatId, message_id: messageId,
reply_markup: { inline_keyboard: [[{ text: t(lang, "menu_back"), callback_data: "panel_main" }]] },
});
return;
}
const inicio = pagina * POR_PAGINA;
const fin = Math.min(inicio + POR_PAGINA, docs.length);
const lineas = [t(lang, "creators_title", docs.length)];
const botones = [];
for (const doc of docs.slice(inicio, fin)) {
const uid = doc.id;
lineas.push(`ID: \`${uid}\`\n   ${tiempoRestante(doc.data()["fechaVencimiento"], lang)}`); botones.push([{ text: t(lang, "manage_btn", uid), callback_data: `panel_creator_${uid}`}]); } const navRow = []; if (pagina > 0) navRow.push({ text: t(lang, "prev"), callback_data:`panel_creadores_${pagina - 1}`}); if (fin < docs.length) navRow.push({ text: t(lang, "next"), callback_data:`panel_creadores_${pagina + 1}` });
if (navRow.length > 0) botones.push(navRow);
botones.push([{ text: t(lang, "menu_back"), callback_data: "panel_main" }]);
await bot.editMessageText(lineas.join("\n"), {
chat_id: chatId, message_id: messageId, parse_mode: "Markdown",
reply_markup: { inline_keyboard: botones },
});
}

async function mostrarCreadorAdmin(chatId, messageId, uid) {
const lang = await getLang(MI_ID_ADMIN);
const doc = await db.collection("creadores").doc(uid).get();
if (!doc.exists) {
await bot.editMessageText("Not found.", { chat_id: chatId, message_id: messageId });
return;
}
const data = doc.data();
const activo = data["activo"] ?? false;
const texto = t(lang, "creator_detail", uid,
activo ? t(lang, "status_active") : t(lang, "status_inactive"),
formatearFecha(data["fechaIngreso"], lang),
formatearFecha(data["fechaVencimiento"], lang),
tiempoRestante(data["fechaVencimiento"], lang)
);
const botones = [
[
{ text: "+1h", callback_data: `add_time_${uid}_1_hora` },
{ text: "+6h", callback_data: `add_time_${uid}_6_hora` },
{ text: "+12h", callback_data: `add_time_${uid}_12_hora` },
],
[
{ text: "+1d", callback_data: `add_time_${uid}_1_dia` },
{ text: "+7d", callback_data: `add_time_${uid}_7_dia` },
{ text: "+15d", callback_data: `add_time_${uid}_15_dia` },
],
[
{ text: "+30d", callback_data: `add_time_${uid}_30_dia` },
{ text: "+90d", callback_data: `add_time_${uid}_90_dia` },
{ text: "+365d", callback_data: `add_time_${uid}_365_dia` },
],
[
{ text: "-1h", callback_data: `add_time_${uid}_-1_hora` },
{ text: "-6h", callback_data: `add_time_${uid}_-6_hora` },
{ text: "-12h", callback_data: `add_time_${uid}_-12_hora` },
],
[
{ text: "-1d", callback_data: `add_time_${uid}_-1_dia` },
{ text: "-7d", callback_data: `add_time_${uid}_-7_dia` },
{ text: "-15d", callback_data: `add_time_${uid}_-15_dia` },
],
[
{ text: "-30d", callback_data: `add_time_${uid}_-30_dia` },
{ text: "-90d", callback_data: `add_time_${uid}_-90_dia` },
{ text: "-365d", callback_data: `add_time_${uid}_-365_dia` },
],
[activo
? { text: t(lang, "deactivate_btn"), callback_data: `toggle_creator_${uid}_false` }
: { text: t(lang, "reactivate_btn"), callback_data: `toggle_creator_${uid}_true` }
],
[{ text: t(lang, "back_list"), callback_data: "panel_creadores_0" }],
];
await bot.editMessageText(texto, {
chat_id: chatId, message_id: messageId, parse_mode: "Markdown",
reply_markup: { inline_keyboard: botones },
});
}

bot.on("message", async (msg) => {
const chatId = msg.chat.id;
const texto = msg.text ?? "";
const userId = msg.from?.id;
if (!userId) return;
const lang = await getLang(userId);

if (estadosSoporte[chatId] && texto && !texto.startsWith("/")) {
delete estadosSoporte[chatId];
try {
await bot.forwardMessage(MI_ID_ADMIN, chatId, msg.message_id);
await bot.sendMessage(chatId, t(lang, "support_sent"));
} catch (error) { console.error(error); }
return;
}

if (userId === MI_ID_ADMIN && msg.reply_to_message?.forward_from && texto && !texto.startsWith("/")) {
try {
await bot.sendMessage(msg.reply_to_message.forward_from.id, texto);
await bot.sendMessage(chatId, t(lang, "support_reply_sent"));
} catch (error) { console.error(error); }
return;
}

if (texto === PALABRA_MAGICA) {
if (userId !== MI_ID_ADMIN) return void bot.sendMessage(chatId, t(lang, "unauthorized"));
return void mostrarPanelPrincipal(chatId);
}

if (estadosCanal[chatId] && userId === MI_ID_ADMIN && texto) {
if (texto === "/listo") {
delete estadosCanal[chatId];
const actuales = await getCanalesObligatorios();
await bot.sendMessage(chatId, t(lang, "canal_set", actuales.length ? actuales.join("\n") : "—"), { parse_mode: "Markdown" });
return;
}
if (texto === "/quitar") {
delete estadosCanal[chatId];
await db.collection("config").doc("global").set({ canalesObligatorios: [] }, { merge: true });
await bot.sendMessage(chatId, t(lang, "canal_removed"));
return;
}
if (texto.startsWith("/quitar @")) {
const quitar = texto.replace("/quitar ", "").trim();
const actuales = await getCanalesObligatorios();
const nuevos = actuales.filter((c) => c !== quitar);
await db.collection("config").doc("global").set({ canalesObligatorios: nuevos }, { merge: true });
await bot.sendMessage(chatId, t(lang, "canal_set", nuevos.length ? nuevos.join("\n") : "—"), { parse_mode: "Markdown" });
return;
}
if (texto.startsWith("@")) {
const actuales = await getCanalesObligatorios();
const canal = texto.trim();
if (!actuales.includes(canal)) actuales.push(canal);
await db.collection("config").doc("global").set({ canalesObligatorios: actuales }, { merge: true });
await bot.sendMessage(chatId, t(lang, "canal_set", actuales.join("\n")), { parse_mode: "Markdown" });
return;
}
}

if (userId !== MI_ID_ADMIN && await enMantenimiento()) {
return void bot.sendMessage(chatId, t(lang, "maintenance_msg"), { parse_mode: "Markdown" });
}

if (texto.startsWith("/start ")) {
const payload = texto.split(" ")[1];
if (payload.startsWith("ref_")) {
const refId = payload.replace("ref_", "");
if (refId && refId !== userId.toString()) {
try {
const uRef = db.collection("usuarios").doc(userId.toString());
const uDoc = await uRef.get();
if (!uDoc.exists || !uDoc.data()?.["referidoPor"]) {
await uRef.set({ referidoPor: refId }, { merge: true });
}
} catch (error) { console.error(error); }
}
await bot.sendMessage(chatId, t(lang, "choose_language"), {
parse_mode: "Markdown",
reply_markup: { inline_keyboard: [
[{ text: "Espanol", callback_data: "set_lang_es" }],
[{ text: "English", callback_data: "set_lang_en" }],
] },
});
return;
}
if (!await exigeCanalGlobal(chatId, userId, lang)) return;
await enviarCaptcha(chatId, payload, lang);
return;
}

if (texto === "/start") {
await bot.sendMessage(chatId, t(lang, "choose_language"), {
parse_mode: "Markdown",
reply_markup: { inline_keyboard: [
[{ text: "Espanol", callback_data: "set_lang_es" }],
[{ text: "English", callback_data: "set_lang_en" }],
]},
});
return;
}

if (texto === "/idioma" || texto === "/language") {
await bot.sendMessage(chatId, t(lang, "choose_language"), {
parse_mode: "Markdown",
reply_markup: { inline_keyboard: [
[{ text: "Espanol", callback_data: "set_lang_es" }],
[{ text: "English", callback_data: "set_lang_en" }],
]},
});
return;
}

if (texto === "/menu") {
if (!await exigeCanalGlobal(chatId, userId, lang)) return;
const vigente = await estaVigente(userId);
if (!vigente) {
const doc = await db.collection("creadores").doc(userId.toString()).get();
if (doc.exists && doc.data()?.["pendiente"]) return void bot.sendMessage(chatId, t(lang, "access_pending"), { parse_mode: "Markdown" });
return void bot.sendMessage(chatId, t(lang, "access_denied"), { parse_mode: "Markdown" });
}
return void mostrarMenuCreador(chatId, lang);
}

if (texto === "/generar_clave") {
if (userId !== MI_ID_ADMIN) return void bot.sendMessage(chatId, t(lang, "unauthorized"));
const nuevaClave = "VIP-" + Math.random().toString(36).substring(2, 8).toUpperCase();
try {
await db.collection("claves").doc(nuevaClave).set({ usada: false, dias: 30, fechaCreacion: firebaseAdmin.firestore.FieldValue.serverTimestamp() });
return void bot.sendMessage(chatId, t(lang, "key_generated", nuevaClave), { parse_mode: "Markdown" });
} catch (error) {
console.error(error);
return void bot.sendMessage(chatId, t(lang, "key_error"));
}
}

if (texto.startsWith("/activar ") || texto.startsWith("/activate ")) {
if (!await exigeCanalGlobal(chatId, userId, lang)) return;
const clave = texto.split(" ")[1];
try {
const claveRef = db.collection("claves").doc(clave);
const claveDoc = await claveRef.get();
if (!claveDoc.exists) return void bot.sendMessage(chatId, t(lang, "key_not_found"));
if (claveDoc.data()?.["usada"]) return void bot.sendMessage(chatId, t(lang, "key_used"));
await claveRef.update({ usada: true, usadaPor: userId });
const diasClave = claveDoc.data()?.["dias"] ?? 30;
const venceClave = new Date();
venceClave.setDate(venceClave.getDate() + diasClave);
await db.collection("creadores").doc(userId.toString()).set({
activo: false, pendiente: true,
fechaIngreso: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
fechaVencimiento: firebaseAdmin.firestore.Timestamp.fromDate(venceClave),
});
await notificarAdminPendiente(userId);
return void bot.sendMessage(chatId, t(lang, "key_valid"), { parse_mode: "Markdown" });
} catch (error) {
console.error(error);
return void bot.sendMessage(chatId, t(lang, "error_generic"));
}
}

if (texto === "/cancelar" || texto === "/cancel") {
if (estadosCreacion[chatId]) { delete estadosCreacion[chatId]; return void bot.sendMessage(chatId, t(lang, "cancel_ok")); }
return void bot.sendMessage(chatId, t(lang, "cancel_none"));
}

if (estadosCreacion[chatId] && estadosCreacion[chatId].paso === 1) {
const estado = estadosCreacion[chatId];
const eLang = estado.lang;
if (!texto.startsWith("@")) return void bot.sendMessage(chatId, t(eLang, "create_channel_invalid"), {
reply_markup: { inline_keyboard: [[{ text: t(eLang, "cancel_process"), callback_data: "cancelar_creacion" }]] },
});
if (estado.canales.includes(texto)) return void bot.sendMessage(chatId, t(eLang, "create_channel_duplicate", texto), {
reply_markup: { inline_keyboard: [[{ text: t(eLang, "cancel_process"), callback_data: "cancelar_creacion" }]] },
});
estado.canales.push(texto);
const lista = estado.canales.map((c, i) => `   ${i + 1}. ${c}`).join("\n");
return void bot.sendMessage(chatId, t(eLang, "create_step1_list", lista), {
parse_mode: "Markdown",
reply_markup: { inline_keyboard: [
[{ text: t(eLang, "create_channels_done"), callback_data: "canales_listo" }],
[{ text: t(eLang, "cancel_process"), callback_data: "cancelar_creacion" }],
]},
});
}
});

bot.on("callback_query", async (query) => {
const chatId = query.message?.chat.id;
const messageId = query.message?.message_id;
const userId = query.from.id;
const data = query.data ?? "";
if (!chatId || !messageId) return;
void bot.answerCallbackQuery(query.id);
const lang = await getLang(userId);

if (data === "set_lang_es" || data === "set_lang_en") {
const newLang = data === "set_lang_es" ? "es" : "en";
await setLang(userId, newLang);
const gate = await verificarCanalGlobal(userId);
if (!gate.ok) {
const lista = gate.faltantes.join(", ");
const botonesGate = gate.faltantes.map((c) => [{ text: t(newLang, "global_join_btn", c), url: `https://t.me/${c.replace("@", "")}` }]);
botonesGate.push([{ text: t(newLang, "global_verify_btn"), callback_data: "check_global" }]);
await bot.editMessageText(t(newLang, "global_gate", lista), {
chat_id: chatId, message_id: messageId, parse_mode: "Markdown",
reply_markup: { inline_keyboard: botonesGate },
});
return;
}
await bot.editMessageText(t(newLang, "language_set") + "\n\n" + t(newLang, "start_welcome"), {
chat_id: chatId, message_id: messageId, parse_mode: "Markdown",
reply_markup: { inline_keyboard: [
[{ text: t(newLang, "trial_btn"), callback_data: "probar_24h" }],
[{ text: t(newLang, "menu_support"), callback_data: "soporte" }],
] },
});
return;
}

if (data === "cancelar_creacion") {
if (estadosCreacion[chatId]) delete estadosCreacion[chatId];
await bot.editMessageText(t(lang, "cancel_ok"), { chat_id: chatId, message_id: messageId });
return;
}

if (data === "probar_24h") {
if (!await exigeCanalGlobal(chatId, userId, lang)) return;
try {
const ref = db.collection("creadores").doc(userId.toString());
const doc = await ref.get();
if (doc.exists && doc.data()?.["pruebaUsada"]) {
await bot.sendMessage(chatId, t(lang, "trial_used"));
return;
}
const vence = new Date(Date.now() + 24 * 60 * 60 * 1000);
await ref.set({
activo: true, pendiente: false, prueba: true, pruebaUsada: true,
fechaIngreso: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
fechaVencimiento: firebaseAdmin.firestore.Timestamp.fromDate(vence),
}, { merge: true });
await bot.sendMessage(chatId, t(lang, "trial_ok"), { parse_mode: "Markdown" });
} catch (error) { console.error(error); }
return;
}

if (data === "soporte") {
estadosSoporte[chatId] = true;
await bot.sendMessage(chatId, t(lang, "support_ask"), { parse_mode: "Markdown" });
return;
}

if (userId !== MI_ID_ADMIN && await enMantenimiento()) {
void bot.answerCallbackQuery(query.id, { text: "Mantenimiento", show_alert: false });
return;
}

if (data === "check_global") {
const { ok, faltantes } = await verificarCanalGlobal(userId);
if (!ok) {
await bot.sendMessage(chatId, t(lang, "global_not_yet", faltantes.join(", ")));
return;
}
await bot.sendMessage(chatId, t(lang, "global_ok"));
await bot.sendMessage(chatId, t(lang, "start_welcome"), { parse_mode: "Markdown" });
return;
}

if (data.startsWith("captcha_")) {
const partes = data.split("_");
const valor = parseInt(partes[partes.length - 1]);
const payload = partes.slice(1, partes.length - 1).join("_");
const estado = estadosCaptcha[chatId];
if (!estado || estado.payload !== payload) return;
if (valor === estado.correcta) {
delete estadosCaptcha[chatId];
try { await bot.deleteMessage(chatId, messageId); } catch (e) {}
await bot.sendMessage(chatId, t(lang, "captcha_ok"));
await procesarDeepLink(chatId, userId, payload, lang, query.from);
} else {
await bot.sendMessage(chatId, t(lang, "captcha_fail"));
await enviarCaptcha(chatId, payload, lang);
}
return;
}

if (data === "menu_referidos") {
try {
const infoBot = await bot.getMe();
const link = `https://t.me/${infoBot.username}?start=ref_${userId}`;
const doc = await db.collection("creadores").doc(userId.toString()).get();
const count = doc.exists ? (doc.data()?.["referidos"] ?? 0) : 0;
const dias = doc.exists ? (doc.data()?.["diasGanados"] ?? 0) : 0;
await bot.editMessageText(t(lang, "ref_title", link, count, dias), { chat_id: chatId, message_id: messageId, parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: t(lang, "menu_back"), callback_data: "menu_main" }]] } });
} catch (error) { console.error(error); }
return;
}

if (data === "menu_main") {
await bot.editMessageText(t(lang, "menu_title"), {
chat_id: chatId, message_id: messageId, parse_mode: "Markdown",
reply_markup: { inline_keyboard: [
[{ text: t(lang, "menu_status"), callback_data: "menu_status" }],
[{ text: t(lang, "menu_links"), callback_data: "menu_enlaces_0" }],
[{ text: t(lang, "menu_create"), callback_data: "menu_crear" }],
[{ text: t(lang, "menu_stats"), callback_data: "menu_stats" }],
[{ text: t(lang, "menu_referidos"), callback_data: "menu_referidos" }],
[{ text: t(lang, "menu_support"), callback_data: "soporte" }],
]},
});
return;
}

if (data === "menu_status") { await mostrarStatusVip(chatId, messageId, userId, lang); return; }

if (data.startsWith("menu_enlaces_")) {
await mostrarEnlacesCreador(chatId, messageId, userId, parseInt(data.replace("menu_enlaces_", "")) || 0, lang);
return;
}

if (data === "menu_crear") {
if (!await estaVigente(userId)) {
await bot.editMessageText(t(lang, "access_denied"), { chat_id: chatId, message_id: messageId });
return;
}
estadosCreacion[chatId] = { paso: 1, canales: [], lang };
await bot.editMessageText(t(lang, "create_step1_empty"), {
chat_id: chatId, message_id: messageId, parse_mode: "Markdown",
reply_markup: { inline_keyboard: [[{ text: t(lang, "cancel_process"), callback_data: "cancelar_creacion" }]] },
});
return;
}

if (data === "canales_listo") {
const estado = estadosCreacion[chatId];
const eLang = estado?.lang ?? lang;
if (!estado || estado.canales.length === 0) {
await bot.editMessageText(t(eLang, "create_need_channel"), {
chat_id: chatId, message_id: messageId,
reply_markup: { inline_keyboard: [[{ text: t(eLang, "cancel_process"), callback_data: "cancelar_creacion" }]] },
});
return;
}
estado.paso = 2;
const lista = estado.canales.map((c, i) => `   ${i + 1}. ${c}`).join("\n");
await bot.editMessageText(t(eLang, "create_step2", lista), {
chat_id: chatId, message_id: messageId, parse_mode: "Markdown",
reply_markup: { inline_keyboard: [[{ text: t(eLang, "cancel_process"), callback_data: "cancelar_creacion" }]] },
});
const onceHandler = async (msg) => {
if (msg.chat.id !== chatId) return;
if (!estadosCreacion[chatId] || estadosCreacion[chatId].paso !== 2) return;
const contenido = msg.text ?? "";
if (!contenido) return;
bot.removeListener("message", onceHandler);
estadosCreacion[chatId].contenido = contenido;
estadosCreacion[chatId].paso = 3;
const lLang = estadosCreacion[chatId].lang ?? lang;
await bot.sendMessage(chatId, t(lLang, "limit_ask"), {
parse_mode: "Markdown",
reply_markup: { inline_keyboard: [
[{ text: t(lLang, "limit_none"), callback_data: "limite_none" }],
[{ text: t(lLang, "limit_exp_1d"), callback_data: "limite_exp_1" }, { text: t(lLang, "limit_exp_7d"), callback_data: "limite_exp_7" }, { text: t(lLang, "limit_exp_30d"), callback_data: "limite_exp_30" }],
[{ text: t(lLang, "limit_uses_10"), callback_data: "limite_uses_10" }, { text: t(lLang, "limit_uses_50"), callback_data: "limite_uses_50" }, { text: t(lLang, "limit_uses_100"), callback_data: "limite_uses_100" }],
[{ text: t(lLang, "cancel_process"), callback_data: "cancelar_creacion" }],
] },
});
};
bot.on("message", onceHandler);
return;
}

if (data.startsWith("limite_")) {
const estado = estadosCreacion[chatId];
if (!estado || estado.paso !== 3 || !estado.contenido) return;
delete estadosCreacion[chatId];
let limite = null;
if (data.startsWith("limite_exp_")) limite = { tipo: "exp", dias: parseInt(data.replace("limite_exp_", "")) || 30 };
else if (data.startsWith("limite_uses_")) limite = { tipo: "uses", usos: parseInt(data.replace("limite_uses_", "")) || 0 };
try { await bot.deleteMessage(chatId, messageId); } catch (e) {}
await guardarEnlace(chatId, userId, estado, limite);
return;
}

if (data === "menu_stats") {
try {
const rawSnap = await db.collection("enlaces").where("creador", "==", userId).get();
const docs = rawSnap.docs.slice().sort((a, b) => (b.data()["desbloqueos"] ?? 0) - (a.data()["desbloqueos"] ?? 0));
if (docs.length === 0) {
await bot.editMessageText(t(lang, "stats_no_links"), { chat_id: chatId, message_id: messageId, parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: t(lang, "menu_back"), callback_data: "menu_main" }]] } });
return;
}
const lineas = [t(lang, "stats_top_title")];
docs.slice(0, 5).forEach((d, i) => lineas.push(t(lang, "stats_row", i + 1, d.id, d.data()["desbloqueos"] ?? 0)));
await bot.editMessageText(lineas.join("\n"), { chat_id: chatId, message_id: messageId, parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: t(lang, "menu_back"), callback_data: "menu_main" }]] } });
} catch (error) { console.error(error); }
return;
}

if (data.startsWith("stats_")) {
const id = data.replace("stats_", "");
try {
const doc = await db.collection("enlaces").doc(id).get();
if (!doc.exists || doc.data()?.["creador"] !== userId) return;
const total = doc.data()["desbloqueos"] ?? 0;
const snap = await db.collection("desbloqueos").where("enlaceId", "==", id).get();
const regs = snap.docs.slice().sort((a, b) => (b.data()["fecha"]?.seconds ?? 0) - (a.data()["fecha"]?.seconds ?? 0)).slice(0, 10);
const lineas = [t(lang, "stats_link_title", id, total)];
if (regs.length === 0) lineas.push(t(lang, "stats_empty"));
regs.forEach((d) => {
const r = d.data();
const fecha = r["fecha"] ? r["fecha"].toDate().toLocaleDateString(lang === "en" ? "en-US" : "es-ES") : "";
lineas.push(t(lang, "stats_unlock_row", r["nombre"] ?? "", fecha));
});
await bot.editMessageText(lineas.join("\n"), { chat_id: chatId, message_id: messageId, parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: t(lang, "menu_back"), callback_data: "menu_enlaces_0" }]] } });
} catch (error) { console.error(error); }
return;
}

if (data.startsWith("del_confirm_")) {
const id = data.replace("del_confirm_", "");
await bot.editMessageText(t(lang, "delete_confirm", id), {
chat_id: chatId, message_id: messageId, parse_mode: "Markdown",
reply_markup: { inline_keyboard: [[
{ text: t(lang, "delete_yes"), callback_data: `del_ok_${id}` },
{ text: t(lang, "delete_cancel"), callback_data: "menu_enlaces_0" },
]]},
});
return;
}

if (data.startsWith("del_ok_")) {
const id = data.replace("del_ok_", "");
try {
const doc = await db.collection("enlaces").doc(id).get();
if (doc.exists && doc.data()?.["creador"] === userId) {
await db.collection("enlaces").doc(id).delete();
await bot.editMessageText(t(lang, "delete_ok", id), {
chat_id: chatId, message_id: messageId, parse_mode: "Markdown",
reply_markup: { inline_keyboard: [
[{ text: t(lang, "menu_links"), callback_data: "menu_enlaces_0" }],
[{ text: t(lang, "menu_back"), callback_data: "menu_main" }],
]},
});
} else {
await bot.editMessageText(t(lang, "delete_no_perm"), { chat_id: chatId, message_id: messageId });
}
} catch (error) { console.error(error); }
return;
}

if (data.startsWith("check_")) {
const payload = data.replace("check_", "");
try {
const snap = await db.collection("enlaces").doc(payload).get();
if (!snap.exists) return;
const datos = snap.data();
const bloqueo = enlaceBloqueado(datos);
if (bloqueo === "expired") { void bot.answerCallbackQuery(query.id, { text: t(lang, "link_expired"), show_alert: true }); return; }
if (bloqueo === "limit") { void bot.answerCallbackQuery(query.id, { text: t(lang, "link_limit"), show_alert: true }); return; }
const { aprobado, faltante } = await verificarTodosLosCanales(obtenerCanales(datos), userId);
if (!aprobado) {
void bot.answerCallbackQuery(query.id, { text: t(lang, "verify_fail", faltante ?? ""), show_alert: true });
} else {
await db.collection("enlaces").doc(payload).update({ desbloqueos: firebaseAdmin.firestore.FieldValue.increment(1) });
await registrarDesbloqueo(payload, datos, userId, query.from);
void bot.editMessageText(t(lang, "verify_success", datos["contenido"]) + t(lang, "content_selfdestruct"), { chat_id: chatId, message_id: messageId, parse_mode: "Markdown" });
programarAutoborrado(chatId, messageId);
}
} catch (error) {
console.error(error);
void bot.answerCallbackQuery(query.id, { text: t(lang, "verify_error"), show_alert: true });
}
return;
}

if (data.startsWith("aprobar_creador_")) {
if (userId !== MI_ID_ADMIN) return;
const uid = data.replace("aprobar_creador_", "");
try {
await db.collection("creadores").doc(uid).update({ activo: true, pendiente: false });
try {
const refSnap = await db.collection("usuarios").doc(uid).get();
const referidoPor = refSnap.exists ? refSnap.data()?.["referidoPor"] : null;
const aprobadoDoc = await db.collection("creadores").doc(uid).get();
if (referidoPor && !aprobadoDoc.data()?.["refRecompensado"]) {
const refDoc = db.collection("creadores").doc(referidoPor.toString());
const refDocSnap = await refDoc.get();
const base = refDocSnap.exists && refDocSnap.data()?.["fechaVencimiento"]?.toDate() > new Date() ? refDocSnap.data()["fechaVencimiento"].toDate() : new Date();
const nuevaFecha = new Date(base);
nuevaFecha.setDate(nuevaFecha.getDate() + DIAS_POR_REFERIDO);
await refDoc.set({ activo: true, referidos: firebaseAdmin.firestore.FieldValue.increment(1), diasGanados: firebaseAdmin.firestore.FieldValue.increment(DIAS_POR_REFERIDO), fechaVencimiento: firebaseAdmin.firestore.Timestamp.fromDate(nuevaFecha), avisoVencimiento: false }, { merge: true });
await db.collection("creadores").doc(uid).update({ refRecompensado: true });
const rLang = await getLang(parseInt(referidoPor));
await bot.sendMessage(parseInt(referidoPor), t(rLang, "ref_reward_notify", uid, DIAS_POR_REFERIDO), { parse_mode: "Markdown" });
}
} catch (error) { console.error("Error al recompensar referido:", error); }
await bot.editMessageText(t(lang, "approved_admin", uid), { chat_id: chatId, message_id: messageId, parse_mode: "Markdown" });
const uLang = await getLang(parseInt(uid));
await bot.sendMessage(parseInt(uid), t(uLang, "approved_notify"), { parse_mode: "Markdown" });
} catch (error) { console.error(error); }
return;
}

if (data.startsWith("rechazar_creador_")) {
if (userId !== MI_ID_ADMIN) return;
const uid = data.replace("rechazar_creador_", "");
try {
await db.collection("creadores").doc(uid).update({ activo: false, pendiente: false });
await bot.editMessageText(t(lang, "rejected_admin", uid), { chat_id: chatId, message_id: messageId, parse_mode: "Markdown" });
const uLang = await getLang(parseInt(uid));
await bot.sendMessage(parseInt(uid), t(uLang, "rejected_notify"), { parse_mode: "Markdown" });
} catch (error) { console.error(error); }
return;
}

if (userId !== MI_ID_ADMIN) return;

if (data === "panel_main") { await mostrarPanelPrincipal(chatId); return; }
if (data.startsWith("panel_pendientes_")) { await mostrarPendientes(chatId, messageId, parseInt(data.replace("panel_pendientes_", "")) || 0); return; }
if (data.startsWith("panel_creadores_")) { await mostrarListaCreadores(chatId, messageId, parseInt(data.replace("panel_creadores_", "")) || 0); return; }
if (data.startsWith("panel_creator_")) { await mostrarCreadorAdmin(chatId, messageId, data.replace("panel_creator_", "")); return; }

if (data === "panel_stats") {
try {
const [uSnap, cSnap, eSnap, dSnap] = await Promise.all([
db.collection("usuarios").get(),
db.collection("creadores").where("activo", "==", true).get(),
db.collection("enlaces").get(),
db.collection("desbloqueos").get(),
]);
const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
const hoySnap = await db.collection("desbloqueos").where("fecha", ">=", firebaseAdmin.firestore.Timestamp.fromDate(hoy)).get();
const porCreador = {};
eSnap.docs.forEach((d) => { const c = d.data()["creador"]; porCreador[c] = (porCreador[c] ?? 0) + (d.data()["desbloqueos"] ?? 0); });
let topId = ""; let topN = 0;
Object.entries(porCreador).forEach(([id, n]) => { if (n > topN) { topN = n; topId = id; } });
const lineas = [t(lang, "stats_global_title"), t(lang, "stats_users", uSnap.size), t(lang, "stats_creators", cSnap.size), t(lang, "stats_links", eSnap.size), t(lang, "stats_unlocks", dSnap.size), t(lang, "stats_unlocks_today", hoySnap.size)];
lineas.push(topId ? t(lang, "stats_top_creator", topId, topN) : t(lang, "stats_none"));
await bot.editMessageText(lineas.join("\n"), { chat_id: chatId, message_id: messageId, parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: t(lang, "menu_back"), callback_data: "panel_main" }]] } });
} catch (error) { console.error(error); }
return;
}

if (data === "panel_export") {
try {
await bot.editMessageText(t(lang, "export_generating"), { chat_id: chatId, message_id: messageId });
const [uSnap, eSnap, dSnap] = await Promise.all([
db.collection("usuarios").limit(1000).get(),
db.collection("enlaces").limit(1000).get(),
db.collection("desbloqueos").limit(1000).get(),
]);
const fmt = (ts) => ts?.toDate ? ts.toDate().toISOString() : "";
const usuarios = uSnap.docs.map((d) => ({ id: d.id, idioma: d.data()["lang"] ?? "", referidoPor: d.data()["referidoPor"] ?? "" }));
const enlaces = eSnap.docs.map((d) => ({ id: d.id, creador: d.data()["creador"] ?? "", canales: (d.data()["canales"] ?? []).join(", "), visitas: d.data()["visitas"] ?? 0, desbloqueos: d.data()["desbloqueos"] ?? 0, expiraEl: fmt(d.data()["expiraEl"]), limiteUsos: d.data()["limiteUsos"] ?? "", fecha: fmt(d.data()["fecha"]) }));
const desbloqueos = dSnap.docs.map((d) => ({ enlaceId: d.data()["enlaceId"] ?? "", creador: d.data()["creador"] ?? "", userId: d.data()["userId"] ?? "", nombre: d.data()["nombre"] ?? "", fecha: fmt(d.data()["fecha"]) }));
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(usuarios), "Usuarios");
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(enlaces), "Enlaces");
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(desbloqueos), "Desbloqueos");
const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
await bot.sendDocument(chatId, buf, { caption: t(lang, "export_ready") }, { filename: "sub2unlock-datos.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
} catch (error) { console.error(error); await bot.sendMessage(chatId, t(lang, "export_error")); }
return;
}

if (data === "panel_mantenimiento") {
try {
const ref = db.collection("config").doc("mantenimiento");
const doc = await ref.get();
const nuevo = !(doc.exists && doc.data()?.["activo"]);
await ref.set({ activo: nuevo }, { merge: true });
await bot.editMessageText(nuevo ? t(lang, "maint_on") : t(lang, "maint_off"), { chat_id: chatId, message_id: messageId, parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: t(lang, "menu_back"), callback_data: "panel_main" }]] } });
} catch (error) { console.error(error); }
return;
}

if (data === "panel_canal") {
try {
const canales = await getCanalesObligatorios();
await bot.editMessageText((canales.length ? t(lang, "canal_current", canales.join("\n")) + "\n\n" : "") + t(lang, "canal_ask"), { chat_id: chatId, message_id: messageId, parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: t(lang, "menu_back"), callback_data: "panel_main" }]] } });
estadosCanal[chatId] = true;
} catch (error) { console.error(error); }
return;
}

if (data === "panel_generar_clave") {
await bot.editMessageText(t(lang, "key_choose_days"), {
chat_id: chatId, message_id: messageId, parse_mode: "Markdown",
reply_markup: { inline_keyboard: [
[{ text: "1 día", callback_data: "gen_clave_1" }, { text: "7 días", callback_data: "gen_clave_7" }],
[{ text: "15 días", callback_data: "gen_clave_15" }, { text: "30 días", callback_data: "gen_clave_30" }],
[{ text: t(lang, "menu_back"), callback_data: "panel_main" }],
] },
});
return;
}

if (data.startsWith("gen_clave_")) {
const dias = parseInt(data.replace("gen_clave_", "")) || 30;
const nuevaClave = "VIP-" + Math.random().toString(36).substring(2, 8).toUpperCase();
try {
await db.collection("claves").doc(nuevaClave).set({ usada: false, dias, fechaCreacion: firebaseAdmin.firestore.FieldValue.serverTimestamp() });
await bot.editMessageText(t(lang, "key_generated_days", nuevaClave, dias), {
chat_id: chatId, message_id: messageId, parse_mode: "Markdown",
reply_markup: { inline_keyboard: [[{ text: t(lang, "menu_back"), callback_data: "panel_main" }]] },
});
} catch (error) { console.error(error); }
return;
}

if (data.startsWith("add_time_")) {
const m = data.match(/^add_time_(.+)_(-?\d+)_(hora|dia)$/);
if (!m) return;
const uid = m[1];
const cantidad = parseInt(m[2]);
const unidad = m[3];
try {
const ref = db.collection("creadores").doc(uid);
const doc = await ref.get();
if (!doc.exists) return;
const venc = doc.data()?.["fechaVencimiento"];
const base = venc && venc.toDate() > new Date() ? venc.toDate() : new Date();
const nuevaFecha = new Date(base);
if (unidad === "hora") nuevaFecha.setHours(nuevaFecha.getHours() + cantidad);
else nuevaFecha.setDate(nuevaFecha.getDate() + cantidad);
const sigueActivo = nuevaFecha > new Date();
await ref.update({ activo: sigueActivo, avisoVencimiento: false, fechaVencimiento: firebaseAdmin.firestore.Timestamp.fromDate(nuevaFecha) });
await mostrarCreadorAdmin(chatId, messageId, uid);
} catch (error) { console.error(error); }
return;
}

if (data.startsWith("toggle_creator_")) {
const m = data.match(/^toggle_creator_(.+)_(true|false)$/);
if (!m) return;
const uid = m[1];
const nuevoEstado = m[2] === "true";
try {
await db.collection("creadores").doc(uid).update({ activo: nuevoEstado });
await mostrarCreadorAdmin(chatId, messageId, uid);
} catch (error) { console.error(error); }
return;
}
});

async function trabajoPeriodico() {
try {
const ahora = new Date();
const en24h = new Date(ahora.getTime() + 24 * 60 * 60 * 1000);
const snap = await db.collection("creadores").where("activo", "==", true).get();
for (const doc of snap.docs) {
const data = doc.data();
const venc = data["fechaVencimiento"];
if (!venc) continue;
const vence = venc.toDate();
if (vence > ahora && vence <= en24h && !data["avisoVencimiento"]) {
const horas = Math.max(1, Math.round((vence - ahora) / 3600000));
const uid = parseInt(doc.id);
try { await bot.sendMessage(uid, t(await getLang(uid), "vip_reminder", horas), { parse_mode: "Markdown" }); } catch (e) {}
await doc.ref.update({ avisoVencimiento: true });
}
}
const desSnap = await db.collection("desbloqueos").orderBy("fecha", "desc").limit(100).get();
for (const d of desSnap.docs) {
const r = d.data();
const enlaceSnap = await db.collection("enlaces").doc(r["enlaceId"]).get();
if (!enlaceSnap.exists) { await d.ref.delete(); continue; }
const canales = obtenerCanales(enlaceSnap.data());
const { aprobado } = await verificarTodosLosCanales(canales, r["userId"]);
if (!aprobado) {
await d.ref.delete();
try { await bot.sendMessage(r["userId"], t(await getLang(r["userId"]), "access_lost"), { parse_mode: "Markdown" }); } catch (e) {}
}
}
} catch (error) { console.error("Error en trabajo periódico:", error); }
}
setTimeout(trabajoPeriodico, 60 * 1000);
setInterval(trabajoPeriodico, 6 * 60 * 60 * 1000);

bot.on("polling_error", (error) => { console.error("Polling error:", error); });

process.on("unhandledRejection", (reason) => {
const msg = reason instanceof Error ? reason.message : String(reason);
if (msg.includes("message is not modified") || msg.includes("message to delete not found") || msg.includes("query is too old") || msg.includes("ETELEGRAM")) return;
console.error("Unhandled rejection:", reason);
});