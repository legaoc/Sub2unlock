import TelegramBot from “node-telegram-bot-api”;
import { db, firebaseAdmin } from “./firebase.js”;
import { t } from “./lang.js”;

const TOKEN = process.env[“TOKEN”];
const MI_ID_ADMIN = parseInt(process.env[“MI_ID_ADMIN”] ?? “0”);
const PALABRA_MAGICA = “/panel”;

if (!TOKEN) throw new Error(“TOKEN environment variable is required.”);
if (!MI_ID_ADMIN) throw new Error(“MI_ID_ADMIN environment variable is required.”);

const bot = new TelegramBot(TOKEN, { polling: true });
const estadosCreacion = {};
const langCache = {};

console.log(“Sub2Unlock Bot iniciado.”);

async function getLang(userId) {
if (langCache[userId]) return langCache[userId];
try {
const doc = await db.collection(“usuarios”).doc(userId.toString()).get();
const lang = doc.exists ? (doc.data()[“lang”] ?? “es”) : “es”;
langCache[userId] = lang;
return lang;
} catch { return “es”; }
}

async function setLang(userId, lang) {
langCache[userId] = lang;
await db.collection(“usuarios”).doc(userId.toString()).set({ lang }, { merge: true });
}

function fechaVencimientoDefault() {
const f = new Date();
f.setDate(f.getDate() + 30);
return f;
}

function formatearFecha(ts, lang) {
if (!ts) return t(lang, “no_date”);
return ts.toDate().toLocaleDateString(lang === “en” ? “en-US” : “es-ES”, {
day: “2-digit”, month: “2-digit”, year: “numeric”,
hour: “2-digit”, minute: “2-digit”,
});
}

function tiempoRestante(ts, lang) {
if (!ts) return t(lang, “time_unknown”);
const diff = ts.toDate().getTime() - Date.now();
if (diff <= 0) return t(lang, “time_expired”);
const dias = Math.floor(diff / 86400000);
const horas = Math.floor((diff % 86400000) / 3600000);
if (dias > 0) return t(lang, “time_days”, dias, horas);
return t(lang, “time_hours”, horas);
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
} catch { return { aprobado: false, faltante: canal }; }
}
return { aprobado: true, faltante: null };
}

function tasaConversion(visitas, desbloqueos) {
if (visitas === 0) return “0%”;
return `${Math.round((desbloqueos / visitas) * 100)}%`;
}

async function notificarAdminPendiente(userId) {
const lang = await getLang(MI_ID_ADMIN);
await bot.sendMessage(MI_ID_ADMIN, t(lang, “admin_notify”, userId), {
parse_mode: “Markdown”,
reply_markup: {
inline_keyboard: [[
{ text: t(lang, “approve_btn_admin”), callback_data: `aprobar_creador_${userId}` },
{ text: t(lang, “reject_btn_admin”), callback_data: `rechazar_creador_${userId}` },
]],
},
});
}

async function mostrarMenuCreador(chatId, lang) {
await bot.sendMessage(chatId, t(lang, “menu_title”), {
parse_mode: “Markdown”,
reply_markup: {
inline_keyboard: [
[{ text: t(lang, “menu_status”), callback_data: “menu_status” }],
[{ text: t(lang, “menu_links”), callback_data: “menu_enlaces_0” }],
[{ text: t(lang, “menu_create”), callback_data: “menu_crear” }],
],
},
});
}

async function mostrarStatusVip(chatId, messageId, userId, lang) {
const doc = await db.collection(“creadores”).doc(userId.toString()).get();
if (!doc.exists) {
await bot.editMessageText(t(lang, “access_denied”), { chat_id: chatId, message_id: messageId });
return;
}
const data = doc.data();
const activo = data[“activo”] ?? false;
const pendiente = data[“pendiente”] ?? false;
const estadoStr = activo ? t(lang, “status_active”) : (pendiente ? t(lang, “status_pending_label”) : t(lang, “status_inactive”));
const texto = [
t(lang, “status_title”),
`Estado: ${estadoStr}`,
`${t(lang, "status_member_since")} ${formatearFecha(data["fechaIngreso"], lang)}`,
`${t(lang, "status_expires")} ${formatearFecha(data["fechaVencimiento"], lang)}`,
tiempoRestante(data[“fechaVencimiento”], lang),
].join(”\n”);
await bot.editMessageText(texto, {
chat_id: chatId, message_id: messageId, parse_mode: “Markdown”,
reply_markup: { inline_keyboard: [[{ text: t(lang, “menu_back”), callback_data: “menu_main” }]] },
});
}

async function mostrarEnlacesCreador(chatId, messageId, userId, pagina, lang) {
const POR_PAGINA = 4;
const rawSnap = await db.collection(“enlaces”).where(“creador”, “==”, userId).get();
const docs = rawSnap.docs.slice().sort((a, b) => {
return (b.data()[“fecha”]?.seconds ?? 0) - (a.data()[“fecha”]?.seconds ?? 0);
});

if (docs.length === 0) {
await bot.editMessageText(t(lang, “no_links”), {
chat_id: chatId, message_id: messageId, parse_mode: “Markdown”,
reply_markup: { inline_keyboard: [
[{ text: t(lang, “menu_create”), callback_data: “menu_crear” }],
[{ text: t(lang, “menu_back”), callback_data: “menu_main” }],
]},
});
return;
}

const total = docs.length;
const inicio = pagina * POR_PAGINA;
const fin = Math.min(inicio + POR_PAGINA, total);
const lineas = [t(lang, “links_title”, total)];
const botones = [];

for (const doc of docs.slice(inicio, fin)) {
const data = doc.data();
const canales = obtenerCanales(data);
const visitas = data[“visitas”] ?? 0;
const desbloqueos = data[“desbloqueos”] ?? 0;
const fechaStr = data[“fecha”] ? data[“fecha”].toDate().toLocaleDateString(lang === “en” ? “en-US” : “es-ES”) : “–”;
lineas.push(`/link\`${doc.id}`\n   ${canales.join(” + “)}\n   ${fechaStr} | v:${visitas} d:${desbloqueos} (${tasaConversion(visitas, desbloqueos)})`); botones.push([{ text: t(lang, "delete_btn", doc.id), callback_data: `del_confirm_${doc.id}` }]);
}

const navRow = [];
if (pagina > 0) navRow.push({ text: t(lang, “prev”), callback_data: `menu_enlaces_${pagina - 1}` });
if (fin < total) navRow.push({ text: t(lang, “next”), callback_data: `menu_enlaces_${pagina + 1}` });
if (navRow.length > 0) botones.push(navRow);
botones.push([{ text: t(lang, “menu_create”), callback_data: “menu_crear” }]);
botones.push([{ text: t(lang, “menu_back”), callback_data: “menu_main” }]);

await bot.editMessageText(lineas.join(”\n”), {
chat_id: chatId, message_id: messageId, parse_mode: “Markdown”,
reply_markup: { inline_keyboard: botones },
});
}

async function mostrarPanelPrincipal(chatId) {
const lang = await getLang(MI_ID_ADMIN);
const snap = await db.collection(“creadores”).where(“pendiente”, “==”, true).get();
await bot.sendMessage(chatId, t(lang, “panel_title”), {
parse_mode: “Markdown”,
reply_markup: { inline_keyboard: [
[{ text: t(lang, “panel_pending_btn”, snap.size), callback_data: “panel_pendientes_0” }],
[{ text: t(lang, “panel_creators_btn”), callback_data: “panel_creadores_0” }],
[{ text: t(lang, “panel_gen_key_btn”), callback_data: “panel_generar_clave” }],
]},
});
}

async function mostrarPendientes(chatId, messageId, pagina) {
const lang = await getLang(MI_ID_ADMIN);
const POR_PAGINA = 5;
const snapshot = await db.collection(“creadores”).where(“pendiente”, “==”, true).get();
if (snapshot.empty) {
await bot.editMessageText(t(lang, “pending_none”), {
chat_id: chatId, message_id: messageId,
reply_markup: { inline_keyboard: [[{ text: t(lang, “menu_back”), callback_data: “panel_main” }]] },
});
return;
}
const todos = snapshot.docs;
const inicio = pagina * POR_PAGINA;
const fin = Math.min(inicio + POR_PAGINA, todos.length);
const lineas = [t(lang, “pending_title”, todos.length)];
const botones = [];
for (const doc of todos.slice(inicio, fin)) {
const uid = doc.id;
const data = doc.data();
lineas.push(`ID: \`${uid}`\n   ${formatearFecha(data[“fechaIngreso”], lang)}`); botones.push([ { text: t(lang, "approve_btn", uid), callback_data: `aprobar_creador_${uid}`}, { text: t(lang, "reject_btn", uid), callback_data:`rechazar_creador_${uid}`}, ]); } const navRow = []; if (pagina > 0) navRow.push({ text: t(lang, "prev"), callback_data:`panel_pendientes_${pagina - 1}`}); if (fin < todos.length) navRow.push({ text: t(lang, "next"), callback_data:`panel_pendientes_${pagina + 1}` });
if (navRow.length > 0) botones.push(navRow);
botones.push([{ text: t(lang, “menu_back”), callback_data: “panel_main” }]);
await bot.editMessageText(lineas.join(”\n”), {
chat_id: chatId, message_id: messageId, parse_mode: “Markdown”,
reply_markup: { inline_keyboard: botones },
});
}

async function mostrarListaCreadores(chatId, messageId, pagina) {
const lang = await getLang(MI_ID_ADMIN);
const POR_PAGINA = 5;
const rawSnap = await db.collection(“creadores”).where(“activo”, “==”, true).get();
const docs = rawSnap.docs.slice().sort((a, b) => {
return (b.data()[“fechaIngreso”]?.seconds ?? 0) - (a.data()[“fechaIngreso”]?.seconds ?? 0);
});
if (docs.length === 0) {
await bot.editMessageText(t(lang, “creators_none”), {
chat_id: chatId, message_id: messageId,
reply_markup: { inline_keyboard: [[{ text: t(lang, “menu_back”), callback_data: “panel_main” }]] },
});
return;
}
const inicio = pagina * POR_PAGINA;
const fin = Math.min(inicio + POR_PAGINA, docs.length);
const lineas = [t(lang, “creators_title”, docs.length)];
const botones = [];
for (const doc of docs.slice(inicio, fin)) {
const uid = doc.id;
lineas.push(`ID: \`${uid}`\n   ${tiempoRestante(doc.data()[“fechaVencimiento”], lang)}`); botones.push([{ text: t(lang, "manage_btn", uid), callback_data: `panel_creator_${uid}`}]); } const navRow = []; if (pagina > 0) navRow.push({ text: t(lang, "prev"), callback_data:`panel_creadores_${pagina - 1}`}); if (fin < docs.length) navRow.push({ text: t(lang, "next"), callback_data:`panel_creadores_${pagina + 1}` });
if (navRow.length > 0) botones.push(navRow);
botones.push([{ text: t(lang, “menu_back”), callback_data: “panel_main” }]);
await bot.editMessageText(lineas.join(”\n”), {
chat_id: chatId, message_id: messageId, parse_mode: “Markdown”,
reply_markup: { inline_keyboard: botones },
});
}

async function mostrarCreadorAdmin(chatId, messageId, uid) {
const lang = await getLang(MI_ID_ADMIN);
const doc = await db.collection(“creadores”).doc(uid).get();
if (!doc.exists) {
await bot.editMessageText(“Not found.”, { chat_id: chatId, message_id: messageId });
return;
}
const data = doc.data();
const activo = data[“activo”] ?? false;
const texto = t(lang, “creator_detail”, uid,
activo ? t(lang, “status_active”) : t(lang, “status_inactive”),
formatearFecha(data[“fechaIngreso”], lang),
formatearFecha(data[“fechaVencimiento”], lang),
tiempoRestante(data[“fechaVencimiento”], lang)
);
const botones = [
[
{ text: “+1h”, callback_data: `add_time_${uid}_1_hora` },
{ text: “+6h”, callback_data: `add_time_${uid}_6_hora` },
{ text: “+12h”, callback_data: `add_time_${uid}_12_hora` },
],
[
{ text: “+1d”, callback_data: `add_time_${uid}_1_dia` },
{ text: “+7d”, callback_data: `add_time_${uid}_7_dia` },
{ text: “+15d”, callback_data: `add_time_${uid}_15_dia` },
],
[
{ text: “+30d”, callback_data: `add_time_${uid}_30_dia` },
{ text: “+90d”, callback_data: `add_time_${uid}_90_dia` },
{ text: “+365d”, callback_data: `add_time_${uid}_365_dia` },
],
[activo
? { text: t(lang, “deactivate_btn”), callback_data: `toggle_creator_${uid}_false` }
: { text: t(lang, “reactivate_btn”), callback_data: `toggle_creator_${uid}_true` }
],
[{ text: t(lang, “back_list”), callback_data: “panel_creadores_0” }],
];
await bot.editMessageText(texto, {
chat_id: chatId, message_id: messageId, parse_mode: “Markdown”,
reply_markup: { inline_keyboard: botones },
});
}

bot.on(“message”, async (msg) => {
const chatId = msg.chat.id;
const texto = msg.text ?? “”;
const userId = msg.from?.id;
if (!userId) return;
const lang = await getLang(userId);

if (texto === PALABRA_MAGICA) {
if (userId !== MI_ID_ADMIN) return void bot.sendMessage(chatId, t(lang, “unauthorized”));
return void mostrarPanelPrincipal(chatId);
}

if (texto.startsWith(”/start “)) {
const payload = texto.split(” “)[1];
try {
const snap = await db.collection(“enlaces”).doc(payload).get();
if (!snap.exists) return void bot.sendMessage(chatId, t(lang, “invalid_link”));
const datos = snap.data();
const canales = obtenerCanales(datos);
const contenido = datos[“contenido”];
await db.collection(“enlaces”).doc(payload).update({ visitas: firebaseAdmin.firestore.FieldValue.increment(1) });
const { aprobado, faltante } = await verificarTodosLosCanales(canales, userId);
if (!aprobado && faltante) {
const botonesCanales = canales.map((c) => [{ text: t(lang, “subscribe_btn”, c), url: `https://t.me/${c.replace("@", "")}` }]);
botonesCanales.push([{ text: t(lang, “verify_btn”), callback_data: `check_${payload}` }]);
return void bot.sendMessage(chatId, canales.length > 1 ? t(lang, “content_locked_multi”, canales.length) : t(lang, “content_locked_single”), {
parse_mode: “Markdown”, reply_markup: { inline_keyboard: botonesCanales },
});
}
await db.collection(“enlaces”).doc(payload).update({ desbloqueos: firebaseAdmin.firestore.FieldValue.increment(1) });
return void bot.sendMessage(chatId, t(lang, “verify_success”, contenido), { parse_mode: “Markdown” });
} catch (error) {
console.error(“Error en deep link:”, error);
return void bot.sendMessage(chatId, t(lang, “error_generic”));
}
}

if (texto === “/start”) {
await bot.sendMessage(chatId, t(lang, “choose_language”), {
parse_mode: “Markdown”,
reply_markup: { inline_keyboard: [
[{ text: “Espanol”, callback_data: “set_lang_es” }],
[{ text: “English”, callback_data: “set_lang_en” }],
]},
});
return;
}

if (texto === “/idioma” || texto === “/language”) {
await bot.sendMessage(chatId, t(lang, “choose_language”), {
parse_mode: “Markdown”,
reply_markup: { inline_keyboard: [
[{ text: “Espanol”, callback_data: “set_lang_es” }],
[{ text: “English”, callback_data: “set_lang_en” }],
]},
});
return;
}

if (texto === “/menu”) {
const vigente = await estaVigente(userId);
if (!vigente) {
const doc = await db.collection(“creadores”).doc(userId.toString()).get();
if (doc.exists && doc.data()?.[“pendiente”]) return void bot.sendMessage(chatId, t(lang, “access_pending”), { parse_mode: “Markdown” });
return void bot.sendMessage(chatId, t(lang, “access_denied”), { parse_mode: “Markdown” });
}
return void mostrarMenuCreador(chatId, lang);
}

if (texto === “/generar_clave”) {
if (userId !== MI_ID_ADMIN) return void bot.sendMessage(chatId, t(lang, “unauthorized”));
const nuevaClave = “VIP-” + Math.random().toString(36).substring(2, 8).toUpperCase();
try {
await db.collection(“claves”).doc(nuevaClave).set({ usada: false, fechaCreacion: firebaseAdmin.firestore.FieldValue.serverTimestamp() });
return void bot.sendMessage(chatId, t(lang, “key_generated”, nuevaClave), { parse_mode: “Markdown” });
} catch (error) {
console.error(error);
return void bot.sendMessage(chatId, t(lang, “key_error”));
}
}

if (texto.startsWith(”/activar “) || texto.startsWith(”/activate “)) {
const clave = texto.split(” “)[1];
try {
const claveRef = db.collection(“claves”).doc(clave);
const claveDoc = await claveRef.get();
if (!claveDoc.exists) return void bot.sendMessage(chatId, t(lang, “key_not_found”));
if (claveDoc.data()?.[“usada”]) return void bot.sendMessage(chatId, t(lang, “key_used”));
await claveRef.update({ usada: true, usadaPor: userId });
await db.collection(“creadores”).doc(userId.toString()).set({
activo: false, pendiente: true,
fechaIngreso: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
fechaVencimiento: firebaseAdmin.firestore.Timestamp.fromDate(fechaVencimientoDefault()),
});
await notificarAdminPendiente(userId);
return void bot.sendMessage(chatId, t(lang, “key_valid”), { parse_mode: “Markdown” });
} catch (error) {
console.error(error);
return void bot.sendMessage(chatId, t(lang, “error_generic”));
}
}

if (texto === “/cancelar” || texto === “/cancel”) {
if (estadosCreacion[chatId]) { delete estadosCreacion[chatId]; return void bot.sendMessage(chatId, t(lang, “cancel_ok”)); }
return void bot.sendMessage(chatId, t(lang, “cancel_none”));
}

if (estadosCreacion[chatId] && estadosCreacion[chatId].paso === 1) {
const estado = estadosCreacion[chatId];
const eLang = estado.lang;
if (!texto.startsWith(”@”)) return void bot.sendMessage(chatId, t(eLang, “create_channel_invalid”), {
reply_markup: { inline_keyboard: [[{ text: t(eLang, “cancel_process”), callback_data: “cancelar_creacion” }]] },
});
if (estado.canales.includes(texto)) return void bot.sendMessage(chatId, t(eLang, “create_channel_duplicate”, texto), {
reply_markup: { inline_keyboard: [[{ text: t(eLang, “cancel_process”), callback_data: “cancelar_creacion” }]] },
});
estado.canales.push(texto);
const lista = estado.canales.map((c, i) => `   ${i + 1}. ${c}`).join(”\n”);
return void bot.sendMessage(chatId, t(eLang, “create_step1_list”, lista), {
parse_mode: “Markdown”,
reply_markup: { inline_keyboard: [
[{ text: t(eLang, “create_channels_done”), callback_data: “canales_listo” }],
[{ text: t(eLang, “cancel_process”), callback_data: “cancelar_creacion” }],
]},
});
}
});

bot.on(“callback_query”, async (query) => {
const chatId = query.message?.chat.id;
const messageId = query.message?.message_id;
const userId = query.from.id;
const data = query.data ?? “”;
if (!chatId || !messageId) return;
void bot.answerCallbackQuery(query.id);
const lang = await getLang(userId);

if (data === “set_lang_es” || data === “set_lang_en”) {
const newLang = data === “set_lang_es” ? “es” : “en”;
await setLang(userId, newLang);
await bot.editMessageText(t(newLang, “language_set”) + “\n\n” + t(newLang, “start_welcome”), {
chat_id: chatId, message_id: messageId, parse_mode: “Markdown”,
});
return;
}

if (data === “cancelar_creacion”) {
if (estadosCreacion[chatId]) delete estadosCreacion[chatId];
await bot.editMessageText(t(lang, “cancel_ok”), { chat_id: chatId, message_id: messageId });
return;
}

if (data === “menu_main”) {
await bot.editMessageText(t(lang, “menu_title”), {
chat_id: chatId, message_id: messageId, parse_mode: “Markdown”,
reply_markup: { inline_keyboard: [
[{ text: t(lang, “menu_status”), callback_data: “menu_status” }],
[{ text: t(lang, “menu_links”), callback_data: “menu_enlaces_0” }],
[{ text: t(lang, “menu_create”), callback_data: “menu_crear” }],
]},
});
return;
}

if (data === “menu_status”) { await mostrarStatusVip(chatId, messageId, userId, lang); return; }

if (data.startsWith(“menu_enlaces_”)) {
await mostrarEnlacesCreador(chatId, messageId, userId, parseInt(data.replace(“menu_enlaces_”, “”)) || 0, lang);
return;
}

if (data === “menu_crear”) {
if (!await estaVigente(userId)) {
await bot.editMessageText(t(lang, “access_denied”), { chat_id: chatId, message_id: messageId });
return;
}
estadosCreacion[chatId] = { paso: 1, canales: [], lang };
await bot.editMessageText(t(lang, “create_step1_empty”), {
chat_id: chatId, message_id: messageId, parse_mode: “Markdown”,
reply_markup: { inline_keyboard: [[{ text: t(lang, “cancel_process”), callback_data: “cancelar_creacion” }]] },
});
return;
}

if (data === “canales_listo”) {
const estado = estadosCreacion[chatId];
const eLang = estado?.lang ?? lang;
if (!estado || estado.canales.length === 0) {
await bot.editMessageText(t(eLang, “create_need_channel”), {
chat_id: chatId, message_id: messageId,
reply_markup: { inline_keyboard: [[{ text: t(eLang, “cancel_process”), callback_data: “cancelar_creacion” }]] },
});
return;
}
estado.paso = 2;
const lista = estado.canales.map((c, i) => `   ${i + 1}. ${c}`).join(”\n”);
await bot.editMessageText(t(eLang, “create_step2”, lista), {
chat_id: chatId, message_id: messageId, parse_mode: “Markdown”,
reply_markup: { inline_keyboard: [[{ text: t(eLang, “cancel_process”), callback_data: “cancelar_creacion” }]] },
});
const onceHandler = async (msg) => {
if (msg.chat.id !== chatId) return;
if (!estadosCreacion[chatId] || estadosCreacion[chatId].paso !== 2) return;
const contenido = msg.text ?? “”;
if (!contenido) return;
bot.removeListener(“message”, onceHandler);
const canalesGuardados = […estadosCreacion[chatId].canales];
const hLang = estadosCreacion[chatId].lang ?? lang;
delete estadosCreacion[chatId];
const idUnico = “prod_” + Date.now();
try {
await db.collection(“enlaces”).doc(idUnico).set({
canales: canalesGuardados, canal: canalesGuardados[0], contenido,
creador: userId, visitas: 0, desbloqueos: 0,
fecha: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
});
const infoBot = await bot.getMe();
const enlace = `https://t.me/${infoBot.username}?start=${idUnico}`;
const listaStr = canalesGuardados.map((c, i) => `   ${i + 1}. ${c}`).join(”\n”);
await bot.sendMessage(chatId, t(hLang, “create_success”, enlace, listaStr), { parse_mode: “Markdown” });
} catch (error) {
console.error(error);
await bot.sendMessage(chatId, t(hLang, “create_error”));
}
};
bot.on(“message”, onceHandler);
return;
}

if (data.startsWith(“del_confirm_”)) {
const id = data.replace(“del_confirm_”, “”);
await bot.editMessageText(t(lang, “delete_confirm”, id), {
chat_id: chatId, message_id: messageId, parse_mode: “Markdown”,
reply_markup: { inline_keyboard: [[
{ text: t(lang, “delete_yes”), callback_data: `del_ok_${id}` },
{ text: t(lang, “delete_cancel”), callback_data: “menu_enlaces_0” },
]]},
});
return;
}

if (data.startsWith(“del_ok_”)) {
const id = data.replace(“del_ok_”, “”);
try {
const doc = await db.collection(“enlaces”).doc(id).get();
if (doc.exists && doc.data()?.[“creador”] === userId) {
await db.collection(“enlaces”).doc(id).delete();
await bot.editMessageText(t(lang, “delete_ok”, id), {
chat_id: chatId, message_id: messageId, parse_mode: “Markdown”,
reply_markup: { inline_keyboard: [
[{ text: t(lang, “menu_links”), callback_data: “menu_enlaces_0” }],
[{ text: t(lang, “menu_back”), callback_data: “menu_main” }],
]},
});
} else {
await bot.editMessageText(t(lang, “delete_no_perm”), { chat_id: chatId, message_id: messageId });
}
} catch (error) { console.error(error); }
return;
}

if (data.startsWith(“check_”)) {
const payload = data.replace(“check_”, “”);
try {
const snap = await db.collection(“enlaces”).doc(payload).get();
if (!snap.exists) return;
const datos = snap.data();
const { aprobado, faltante } = await verificarTodosLosCanales(obtenerCanales(datos), userId);
if (!aprobado) {
void bot.answerCallbackQuery(query.id, { text: t(lang, “verify_fail”, faltante ?? “”), show_alert: true });
} else {
await db.collection(“enlaces”).doc(payload).update({ desbloqueos: firebaseAdmin.firestore.FieldValue.increment(1) });
void bot.editMessageText(t(lang, “verify_success”, datos[“contenido”]), { chat_id: chatId, message_id: messageId, parse_mode: “Markdown” });
}
} catch (error) {
console.error(error);
void bot.answerCallbackQuery(query.id, { text: t(lang, “verify_error”), show_alert: true });
}
return;
}

if (data.startsWith(“aprobar_creador_”)) {
if (userId !== MI_ID_ADMIN) return;
const uid = data.replace(“aprobar_creador_”, “”);
try {
await db.collection(“creadores”).doc(uid).update({ activo: true, pendiente: false });
await bot.editMessageText(t(lang, “approved_admin”, uid), { chat_id: chatId, message_id: messageId, parse_mode: “Markdown” });
const uLang = await getLang(parseInt(uid));
await bot.sendMessage(parseInt(uid), t(uLang, “approved_notify”), { parse_mode: “Markdown” });
} catch (error) { console.error(error); }
return;
}

if (data.startsWith(“rechazar_creador_”)) {
if (userId !== MI_ID_ADMIN) return;
const uid = data.replace(“rechazar_creador_”, “”);
try {
await db.collection(“creadores”).doc(uid).update({ activo: false, pendiente: false });
await bot.editMessageText(t(lang, “rejected_admin”, uid), { chat_id: chatId, message_id: messageId, parse_mode: “Markdown” });
const uLang = await getLang(parseInt(uid));
await bot.sendMessage(parseInt(uid), t(uLang, “rejected_notify”), { parse_mode: “Markdown” });
} catch (error) { console.error(error); }
return;
}

if (userId !== MI_ID_ADMIN) return;

if (data === “panel_main”) { await mostrarPanelPrincipal(chatId); return; }
if (data.startsWith(“panel_pendientes_”)) { await mostrarPendientes(chatId, messageId, parseInt(data.replace(“panel_pendientes_”, “”)) || 0); return; }
if (data.startsWith(“panel_creadores_”)) { await mostrarListaCreadores(chatId, messageId, parseInt(data.replace(“panel_creadores_”, “”)) || 0); return; }
if (data.startsWith(“panel_creator_”)) { await mostrarCreadorAdmin(chatId, messageId, data.replace(“panel_creator_”, “”)); return; }

if (data === “panel_generar_clave”) {
const nuevaClave = “VIP-” + Math.random().toString(36).substring(2, 8).toUpperCase();
try {
await db.collection(“claves”).doc(nuevaClave).set({ usada: false, fechaCreacion: firebaseAdmin.firestore.FieldValue.serverTimestamp() });
await bot.editMessageText(t(lang, “key_generated”, nuevaClave), {
chat_id: chatId, message_id: messageId, parse_mode: “Markdown”,
reply_markup: { inline_keyboard: [[{ text: t(lang, “menu_back”), callback_data: “panel_main” }]] },
});
} catch (error) { console.error(error); }
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
} catch (error) { console.error(error); }
return;
}

if (data.startsWith(“toggle_creator_”)) {
const partes = data.split(”*”);
const nuevoEstado = partes[partes.length - 1] === “true”;
const uid = partes.slice(2, partes.length - 1).join(”*”);
try {
await db.collection(“creadores”).doc(uid).update({ activo: nuevoEstado });
await mostrarCreadorAdmin(chatId, messageId, uid);
} catch (error) { console.error(error); }
return;
}
});

bot.on(“polling_error”, (error) => { console.error(“Polling error:”, error); });

process.on(“unhandledRejection”, (reason) => {
const msg = reason instanceof Error ? reason.message : String(reason);
if (msg.includes(“message is not modified”) || msg.includes(“message to delete not found”) || msg.includes(“query is too old”) || msg.includes(“ETELEGRAM”)) return;
console.error(“Unhandled rejection:”, reason);
});