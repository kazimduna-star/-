(function () {
  let c = null;
  try { c = JSON.parse(localStorage.getItem("mb_cfg") || "null"); } catch {}
  const ok = u => /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(u || "");
  if (!c || !ok(c.u)) c = { u: CFG.SUPABASE_URL, k: CFG.SUPABASE_ANON_KEY };
  while (!ok(c.u) || !(c.k || "").startsWith("eyJ") && !(c.k || "").startsWith("sb_")) {
    const u = (prompt("Вставьте Project URL из Supabase (https://xxxx.supabase.co):") || "").trim().replace(/\/+$/, "");
    const k = (prompt("Вставьте ключ anon public (начинается с eyJ...):") || "").trim();
    c = { u, k };
    if (ok(u) && k) localStorage.setItem("mb_cfg", JSON.stringify(c));
  }
  window.SB = c;
})();
window.resetCfg = () => { localStorage.removeItem("mb_cfg"); location.reload(); };
const sb = supabase.createClient(SB.u, SB.k);
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let me = null, peer = null, msgs = [], profs = {}, online = {}, presCh, dbCh, started = false, unreadTitle = 0;

// ---------- helpers ----------
const av = (p, cls = "") => p?.avatar_url
  ? `<img class="av ${cls}" src="${esc(p.avatar_url)}" alt="">`
  : `<div class="av ${cls}">${esc((p?.username || "?")[0].toUpperCase())}</div>`;
const hm = d => new Date(d).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const dayStr = d => new Date(d).toLocaleDateString([], { day: "numeric", month: "long" });
function toast(t, cb) {
  const el = $("#toast"); el.textContent = t; el.classList.add("show"); el.onclick = () => { el.classList.remove("show"); cb && cb(); };
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove("show"), 4000);
}
function status(p) {
  if (!p) return "";
  if (online[p.id]) return `<span class="dot"></span>в сети`;
  return p.last_seen ? "был(а) " + (new Date(p.last_seen).toDateString() === new Date().toDateString() ? "в " + hm(p.last_seen) : dayStr(p.last_seen)) : "не в сети";
}
async function getProfile(id) {
  if (profs[id]) return profs[id];
  const { data } = await sb.from("profiles").select("*").eq("id", id).maybeSingle();
  if (data) profs[id] = data; return data;
}

// ---------- auth ----------
let regMode = false;
function setMode(r) {
  regMode = r; $("#aName").hidden = !r; $("#aGo").textContent = r ? "Создать аккаунт" : "Войти";
  $("#tabReg").classList.toggle("on", r); $("#tabLogin").classList.toggle("on", !r); $("#aErr").textContent = "";
}
$("#tabLogin").onclick = () => setMode(false);
$("#tabReg").onclick = () => setMode(true);
$("#aGo").onclick = async () => {
  const email = $("#aEmail").value.trim(), password = $("#aPass").value, username = $("#aName").value.trim();
  const err = $("#aErr"); err.textContent = "";
  if (!email || password.length < 6) return err.textContent = "Введите email и пароль (минимум 6 символов).";
  if (regMode && !username) return err.textContent = "Введите имя пользователя.";
  $("#aGo").disabled = true;
  let res;
  try {
    res = regMode
      ? await sb.auth.signUp({ email, password, options: { data: { username } } })
      : await sb.auth.signInWithPassword({ email, password });
  } catch (e) {
    $("#aGo").disabled = false;
    err.innerHTML = `Нет связи с Supabase (${esc(e.message)}). Неверный URL/ключ или проект на паузе. <u onclick="resetCfg()">Ввести ключи заново</u>`;
    return;
  }
  $("#aGo").disabled = false;
  if (res.error) return err.textContent = res.error.message;
  if (regMode && !res.data.session) err.textContent = "Аккаунт создан. Подтвердите email по письму и войдите.";
};
$("#stOut").onclick = async () => { await sb.auth.signOut(); };

sb.auth.onAuthStateChange((ev, session) => {
  if (session && !started) { started = true; setTimeout(() => start(session.user), 0); }
  if (!session && started) location.reload();
  if (!session) { $("#auth").hidden = false; $("#app").hidden = true; }
});

// ---------- start ----------
async function start(user) {
  let p = null;
  for (let i = 0; i < 6 && !p; i++) {
    p = (await sb.from("profiles").select("*").eq("id", user.id).maybeSingle()).data;
    if (!p) await new Promise(r => setTimeout(r, 500));
  }
  if (!p) { alert("Профиль не найден. Проверьте, что supabase.sql выполнен полностью."); started = false; return; }
  me = p; profs[me.id] = me;
  $("#auth").hidden = true; $("#app").hidden = false;
  $("#pId").textContent = me.mb_id; $("#pName").value = me.username; $("#stInfo").textContent = `${me.username} · ${me.mb_id}`;
  await loadMsgs(); render(); renderProfile(); renderNotifBtn();

  dbCh = sb.channel("db-" + me.id)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, e => onMsg(e.new))
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "messages" }, e => { upsert(e.new); render(); })
    .subscribe();

  presCh = sb.channel("presence", { config: { presence: { key: me.id } } });
  presCh.on("presence", { event: "sync" }, () => { online = presCh.presenceState(); render(); })
    .subscribe(s => { if (s === "SUBSCRIBED") presCh.track({ at: Date.now() }); });

  const ping = () => sb.from("profiles").update({ last_seen: new Date().toISOString() }).eq("id", me.id);
  ping(); setInterval(ping, 60000);
  window.addEventListener("pagehide", ping);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) { loadMsgs().then(render); unreadTitle = 0; document.title = "MB CHAT"; if (peer) markRead(peer.id); }
  });
}

async function loadMsgs() {
  const { data, error } = await sb.from("messages").select("*")
    .or(`sender_id.eq.${me.id},receiver_id.eq.${me.id}`).order("created_at", { ascending: true }).limit(2000);
  if (error) return toast("Ошибка загрузки: " + error.message);
  msgs = data;
  await Promise.all([...new Set(msgs.map(m => m.sender_id === me.id ? m.receiver_id : m.sender_id))].map(getProfile));
  const undel = msgs.filter(m => m.receiver_id === me.id && !m.delivered_at).map(m => m.id);
  if (undel.length) {
    const t = new Date().toISOString();
    const r = await sb.from("messages").update({ delivered_at: t }).in("id", undel);
    if (!r.error) msgs.forEach(m => { if (undel.includes(m.id)) m.delivered_at = t; });
  }
}
function upsert(m) { const i = msgs.findIndex(x => x.id === m.id); i < 0 ? msgs.push(m) : (msgs[i] = m); }

async function onMsg(m) {
  upsert(m);
  if (m.receiver_id === me.id) {
    const from = await getProfile(m.sender_id);
    const t = new Date().toISOString();
    if (peer?.id === m.sender_id && !document.hidden) await markRead(peer.id);
    else {
      sb.from("messages").update({ delivered_at: t }).eq("id", m.id).then(() => { m.delivered_at = t; render(); });
      toast(`${from?.username || "Новое сообщение"}: ${m.body.slice(0, 60)}`, () => from && openChat(from));
      if (document.hidden) { document.title = `(${++unreadTitle}) MB CHAT`; }
      if ("Notification" in window && Notification.permission === "granted" && document.hidden)
        new Notification(from?.username || "MB CHAT", { body: m.body.slice(0, 100) });
    }
  }
  render();
}

async function markRead(pid) {
  const ids = msgs.filter(m => m.sender_id === pid && m.receiver_id === me.id && !m.read_at).map(m => m.id);
  if (!ids.length) return;
  const t = new Date().toISOString();
  const { error } = await sb.from("messages").update({ read_at: t, delivered_at: t }).in("id", ids);
  if (!error) msgs.forEach(m => { if (ids.includes(m.id)) m.read_at = m.delivered_at = t; });
}

// ---------- render ----------
function render() { renderChats(); if (peer) renderChat(); }
function renderChats() {
  const map = {};
  msgs.forEach(m => { const pid = m.sender_id === me.id ? m.receiver_id : m.sender_id; (map[pid] ||= []).push(m); });
  const list = Object.entries(map).sort((a, b) => new Date(b[1].at(-1).created_at) - new Date(a[1].at(-1).created_at));
  let total = 0;
  $("#chatlist").innerHTML = list.length ? list.map(([pid, arr]) => {
    const p = profs[pid], l = arr.at(-1), un = arr.filter(m => m.receiver_id === me.id && !m.read_at).length; total += un;
    return `<div class="row" data-p="${pid}">${av(p)}<div class="mid"><div class="name">${esc(p?.username)}</div>
      <div class="last">${l.sender_id === me.id ? "Вы: " : ""}${esc(l.body)}</div></div>
      <div class="meta">${hm(l.created_at)}${un ? `<div><span class="badge">${un}</span></div>` : ""}</div></div>`;
  }).join("") : `<div class="empty">Пока нет переписок.<br>Найдите человека по ID на вкладке «Поиск».</div>`;
  $("#chatlist").querySelectorAll(".row").forEach(r => r.onclick = () => openChat(profs[r.dataset.p]));
  $("#nb").hidden = !total; $("#nb").textContent = total;
}
function tick(m) {
  if (m.sender_id !== me.id) return "";
  return m.read_at ? `<small class="r">${hm(m.created_at)} ✓✓</small>` : m.delivered_at ? `<small>${hm(m.created_at)} ✓✓</small>` : `<small>${hm(m.created_at)} ✓</small>`;
}
function renderChat() {
  const box = $("#msgs"), near = box.scrollHeight - box.scrollTop - box.clientHeight < 120 || !box.children.length;
  const p = profs[peer.id] || peer;
  $("#cAv").innerHTML = av(p); $("#cName").textContent = p.username; $("#cSt").innerHTML = status(p);
  let last = "", html = "";
  msgs.filter(m => m.sender_id === peer.id || m.receiver_id === peer.id).forEach(m => {
    const d = dayStr(m.created_at); if (d !== last) { html += `<div class="day">${d}</div>`; last = d; }
    html += `<div class="m ${m.sender_id === me.id ? "me" : ""}">${esc(m.body)}${tick(m) || `<small>${hm(m.created_at)}</small>`}</div>`;
  });
  box.innerHTML = html;
  if (near) box.scrollTop = box.scrollHeight;
}
async function openChat(p) {
  if (!p) return;
  peer = p; profs[p.id] = profs[p.id] || p;
  const fresh = (await sb.from("profiles").select("*").eq("id", p.id).maybeSingle()).data; if (fresh) { profs[p.id] = fresh; peer = fresh; }
  $("#chat").hidden = false; $("#msgs").innerHTML = ""; renderChat();
  await markRead(peer.id); render();
}
$("#back").onclick = () => { peer = null; $("#chat").hidden = true; render(); };

// ---------- send ----------
$("#sendf").onsubmit = async e => {
  e.preventDefault();
  const body = $("#mIn").value.trim(); if (!body || !peer) return;
  $("#mIn").value = ""; $("#mIn").style.height = "auto";
  const { data, error } = await sb.from("messages").insert({ sender_id: me.id, receiver_id: peer.id, body }).select().single();
  if (error) { $("#mIn").value = body; return toast("Не отправлено: " + error.message); }
  upsert(data); render();
};
$("#mIn").oninput = e => { e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px"; };
$("#mIn").onkeydown = e => { if (e.key === "Enter" && !e.shiftKey && window.innerWidth > 800) { e.preventDefault(); $("#sendf").requestSubmit(); } };

// ---------- tabs ----------
document.querySelectorAll("nav button").forEach(b => b.onclick = () => {
  document.querySelectorAll("nav button").forEach(x => x.classList.toggle("on", x === b));
  document.querySelectorAll("main>section").forEach(s => s.hidden = s.id !== "t-" + b.dataset.t);
});

// ---------- search ----------
async function search() {
  const id = $("#sId").value.trim().toUpperCase(), out = $("#sRes");
  if (!/^MB\d{6}$/.test(id)) return out.innerHTML = `<div class="empty">Введите ID в формате MB123456.</div>`;
  const { data, error } = await sb.from("profiles").select("*").eq("mb_id", id).maybeSingle();
  if (error) return out.innerHTML = `<div class="empty">Ошибка: ${esc(error.message)}</div>`;
  if (!data) return out.innerHTML = `<div class="empty">Пользователь с ID ${esc(id)} не найден.</div>`;
  profs[data.id] = data;
  out.innerHTML = `<div class="card">${av(data, "big")}<div style="font-size:20px;font-weight:700">${esc(data.username)}</div>
    <div class="id">${esc(data.mb_id)}</div><div class="dim" style="margin:6px 0 12px">${status(data)}</div>
    ${data.id === me.id ? `<div class="dim">Это вы</div>` : `<button id="sWrite">Написать</button>`}</div>`;
  const w = $("#sWrite"); if (w) w.onclick = () => openChat(data);
}
$("#sGo").onclick = search;
$("#sId").onkeydown = e => { if (e.key === "Enter") search(); };

// ---------- profile ----------
function renderProfile() { $("#pAv").innerHTML = av(me, "big"); }
$("#pSave").onclick = async () => {
  const username = $("#pName").value.trim(); if (!username) return $("#pErr").textContent = "Имя не может быть пустым.";
  const { error } = await sb.from("profiles").update({ username }).eq("id", me.id);
  $("#pErr").textContent = error ? error.message : ""; if (!error) { me.username = username; toast("Имя сохранено"); }
};
$("#pAvBtn").onclick = () => $("#pFile").click();
$("#pFile").onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const img = await createImageBitmap(f), s = 256, c = document.createElement("canvas"); c.width = c.height = s;
    const k = Math.max(s / img.width, s / img.height);
    c.getContext("2d").drawImage(img, (s - img.width * k) / 2, (s - img.height * k) / 2, img.width * k, img.height * k);
    const blob = await new Promise(r => c.toBlob(r, "image/jpeg", .85));
    const path = `${me.id}/avatar_${Date.now()}.jpg`;
    const up = await sb.storage.from("avatars").upload(path, blob, { contentType: "image/jpeg" });
    if (up.error) throw up.error;
    const url = sb.storage.from("avatars").getPublicUrl(path).data.publicUrl;
    const { error } = await sb.from("profiles").update({ avatar_url: url }).eq("id", me.id);
    if (error) throw error;
    me.avatar_url = url; renderProfile(); toast("Аватар обновлён");
  } catch (er) { $("#pErr").textContent = "Не удалось загрузить: " + (er.message || er); }
  e.target.value = "";
};

// ---------- settings ----------
function renderNotifBtn() {
  const b = $("#stNotif");
  if (!("Notification" in window)) { b.textContent = "Системные уведомления недоступны в этом браузере"; b.disabled = true; return; }
  b.textContent = Notification.permission === "granted" ? "Уведомления включены ✓" : "Включить уведомления";
}
$("#stNotif").onclick = async () => { await Notification.requestPermission(); renderNotifBtn(); };
$("#stCopy").onclick = async () => { try { await navigator.clipboard.writeText(me.mb_id); toast("ID скопирован"); } catch { toast("Ваш ID: " + me.mb_id); } };

// ---------- init ----------
setMode(false);
sb.auth.getSession().then(({ data }) => { if (!data.session) $("#auth").hidden = false; });
