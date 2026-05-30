/* ============================================================
   アーバンネット キッチンカー スケジュール
   Supabase backend + vanilla JS SPA
   ============================================================ */

const SUPABASE_URL = "https://tfkzsbwhvhgxbnnfwtou.supabase.co";
const SUPABASE_KEY = "sb_publishable_Ro1VwRK4o96IkyV6JC0q6w_vCjfFWYm";

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

/* 初期出店者（テーブルが空の場合に投入） */
const DEFAULT_VENDORS = [
  "Novel café",
  "FoodieGent",
  "プヨ",
  "チキンとポテトのお店ポテタロさん",
  "つむKITCHEN",
  "移動販売VEC",
  "HOT MEAL  3*SUN*",
  "珈琲バルSTRAY CAT",
  "あんだんち＋",
];

/* 料金ルール */
const FEE_PER_VISIT = 2000; // 税別
const FREE_AFTER = 3; // 4回目以降無料 → 課金対象は最大3回

/* 出店料が常に無料の出店者（毎月0円）。
   表記揺れ（スペース・引用符・大文字小文字）を無視して判定する。 */
const FEE_EXEMPT_VENDORS = ["Route 227s `Cafe"];
function normalizeVendorName(name) {
  return String(name).toLowerCase().replace(/[\s`'’"]/g, "");
}
const FEE_EXEMPT_SET = new Set(FEE_EXEMPT_VENDORS.map(normalizeVendorName));
function isFeeExempt(name) {
  return FEE_EXEMPT_SET.has(normalizeVendorName(name));
}

/* 日本の祝日（自動グレー表示用。任意日の休日設定はDBで別管理） */
const JP_HOLIDAYS = new Set([
  // 2025
  "2025-01-01","2025-01-13","2025-02-11","2025-02-23","2025-02-24","2025-03-20",
  "2025-04-29","2025-05-03","2025-05-04","2025-05-05","2025-05-06","2025-07-21",
  "2025-08-11","2025-09-15","2025-09-23","2025-10-13","2025-11-03","2025-11-23","2025-11-24",
  // 2026
  "2026-01-01","2026-01-12","2026-02-11","2026-02-23","2026-03-20","2026-04-29",
  "2026-05-03","2026-05-04","2026-05-05","2026-05-06","2026-07-20","2026-08-11",
  "2026-09-21","2026-09-22","2026-09-23","2026-10-12","2026-11-03","2026-11-23",
  // 2027
  "2027-01-01","2027-01-11","2027-02-11","2027-02-23","2027-03-21","2027-03-22",
  "2027-04-29","2027-05-03","2027-05-04","2027-05-05","2027-07-19","2027-08-11",
  "2027-09-20","2027-09-23","2027-10-11","2027-11-03","2027-11-23",
]);

/* ---------------- State ---------------- */
let state = {
  view: "calendar",
  calYear: 0,
  calMonth: 0, // 0-indexed
  feeYear: 0,
  feeMonth: 0,
  vendors: [], // {id, name}
  openings: {}, // "YYYY-MM-DD" -> [{id, vendor_id}]
  holidays: new Set(), // custom holidays "YYYY-MM-DD"
  selectedDate: null,
};

/* ---------------- Helpers ---------------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function pad(n) { return String(n).padStart(2, "0"); }
function ymd(y, m0, d) { return `${y}-${pad(m0 + 1)}-${pad(d)}`; }
function todayStr() {
  const t = new Date();
  return ymd(t.getFullYear(), t.getMonth(), t.getDate());
}
function monthLabel(y, m0) { return `${y}年 ${m0 + 1}月`; }
function vendorName(id) {
  const v = state.vendors.find((x) => x.id === id);
  return v ? v.name : "（不明）";
}
function isWeekend(y, m0, d) {
  const w = new Date(y, m0, d).getDay();
  return w === 0 || w === 6;
}
function dayOfWeek(y, m0, d) { return new Date(y, m0, d).getDay(); }

let toastTimer;
function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  el.classList.toggle("error", isError);
  requestAnimationFrame(() => el.classList.add("show"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => (el.hidden = true), 350);
  }, 2600);
}

/* ---------------- Data layer ---------------- */
async function ensureVendors() {
  const { data, error } = await sb.from("vendors").select("id, name").order("id");
  if (error) throw error;
  if (data.length === 0) {
    const rows = DEFAULT_VENDORS.map((name) => ({ name }));
    const { data: inserted, error: insErr } = await sb
      .from("vendors").insert(rows).select("id, name").order("id");
    if (insErr) throw insErr;
    state.vendors = inserted;
  } else {
    state.vendors = data;
  }
}

async function loadVendors() {
  const { data, error } = await sb.from("vendors").select("id, name").order("name");
  if (error) throw error;
  state.vendors = data;
}

function monthRange(y, m0) {
  const start = ymd(y, m0, 1);
  const lastDay = new Date(y, m0 + 1, 0).getDate();
  const end = ymd(y, m0, lastDay);
  return { start, end };
}

async function loadMonthData(y, m0) {
  const { start, end } = monthRange(y, m0);

  const [openRes, holRes] = await Promise.all([
    sb.from("openings").select("id, opening_date, vendor_id").gte("opening_date", start).lte("opening_date", end),
    sb.from("holidays").select("holiday_date").gte("holiday_date", start).lte("holiday_date", end),
  ]);
  if (openRes.error) throw openRes.error;
  if (holRes.error) throw holRes.error;

  const openings = {};
  for (const row of openRes.data) {
    (openings[row.opening_date] ||= []).push({ id: row.id, vendor_id: row.vendor_id });
  }
  state.openings = openings;
  state.holidays = new Set(holRes.data.map((r) => r.holiday_date));
}

/* ---------------- Calendar rendering ---------------- */
function statusClass(count) {
  if (count >= 3) return "s-over";
  if (count === 2) return "s-full";
  if (count === 1) return "s-one";
  return "s-open";
}

function renderCalendar() {
  $("#month-label").textContent = monthLabel(state.calYear, state.calMonth);
  const grid = $("#calendar-grid");
  grid.innerHTML = "";

  const y = state.calYear, m0 = state.calMonth;
  const firstDow = new Date(y, m0, 1).getDay();
  const daysInMonth = new Date(y, m0 + 1, 0).getDate();
  const today = todayStr();

  for (let i = 0; i < firstDow; i++) {
    const cell = document.createElement("div");
    cell.className = "cell empty";
    grid.appendChild(cell);
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = ymd(y, m0, d);
    const dow = dayOfWeek(y, m0, d);
    const weekend = dow === 0 || dow === 6;
    const isHoliday = state.holidays.has(dateStr) || JP_HOLIDAYS.has(dateStr) || weekend;
    const list = state.openings[dateStr] || [];

    const cell = document.createElement("div");
    cell.className = "cell";
    cell.dataset.date = dateStr;
    if (dateStr === today) cell.classList.add("today");

    const dateEl = document.createElement("div");
    dateEl.className = "date";
    if (dow === 0) dateEl.classList.add("sun-date");
    if (dow === 6) dateEl.classList.add("sat-date");
    dateEl.textContent = d;
    cell.appendChild(dateEl);

    const bar = document.createElement("div");
    bar.className = "status-bar";
    cell.appendChild(bar);

    if (isHoliday) {
      cell.classList.add(weekend ? "weekend" : "holiday");
      if (list.length > 0) {
        // 万一、休日でも出店登録がある場合は色付けして表示
        cell.classList.add(statusClass(list.length));
        appendVendorTags(cell, list);
      } else {
        const tag = document.createElement("div");
        tag.className = "holiday-tag";
        tag.textContent = "休";
        cell.appendChild(tag);
      }
    } else {
      cell.classList.add(statusClass(list.length));
      appendVendorTags(cell, list);
    }

    cell.addEventListener("click", () => openDayModal(dateStr));
    grid.appendChild(cell);
  }
}

function appendVendorTags(cell, list) {
  if (list.length === 0) return;
  const wrap = document.createElement("div");
  wrap.className = "vendors";
  for (const o of list) {
    const t = document.createElement("div");
    t.className = "v-tag";
    t.textContent = vendorName(o.vendor_id);
    wrap.appendChild(t);
  }
  cell.appendChild(wrap);
}

/* ---------------- List view rendering ---------------- */
const STATUS_LABEL = {
  "s-open": "空き",
  "s-one": "残り1枠",
  "s-full": "満員（2者）",
  "s-over": "要調整（3者以上）",
};

function renderList() {
  $("#list-month-label").textContent = monthLabel(state.calYear, state.calMonth);
  const wrap = $("#list-container");
  wrap.innerHTML = "";

  const y = state.calYear, m0 = state.calMonth;
  const daysInMonth = new Date(y, m0 + 1, 0).getDate();
  const dows = ["日", "月", "火", "水", "木", "金", "土"];
  let shown = 0;

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = ymd(y, m0, d);
    const dow = dayOfWeek(y, m0, d);
    const weekend = dow === 0 || dow === 6;
    const isHoliday = state.holidays.has(dateStr) || JP_HOLIDAYS.has(dateStr) || weekend;
    const list = state.openings[dateStr] || [];

    // 休日かつ出店なしの日はリストでは省略（出店のある日と平日のみ表示）
    if (isHoliday && list.length === 0) continue;
    shown++;

    const row = document.createElement("div");
    row.className = "list-row";
    row.dataset.date = dateStr;

    const dateCol = document.createElement("div");
    dateCol.className = "list-date";
    if (dow === 0) dateCol.classList.add("sun-date");
    if (dow === 6) dateCol.classList.add("sat-date");
    if (dateStr === todayStr()) dateCol.classList.add("is-today");
    dateCol.innerHTML = `<span class="ld-num">${d}</span><span class="ld-dow">${dows[dow]}</span>`;
    row.appendChild(dateCol);

    const body = document.createElement("div");
    body.className = "list-body";

    const statusCls = isHoliday ? "s-holiday" : statusClass(list.length);
    const badge = document.createElement("span");
    badge.className = "list-status " + statusCls;
    badge.textContent = isHoliday ? "休日" : STATUS_LABEL[statusCls];
    body.appendChild(badge);

    if (list.length > 0) {
      const names = document.createElement("div");
      names.className = "list-vendors";
      for (const o of list) {
        const chip = document.createElement("span");
        chip.className = "list-vendor";
        chip.textContent = vendorName(o.vendor_id);
        names.appendChild(chip);
      }
      body.appendChild(names);
    } else if (!isHoliday) {
      const empty = document.createElement("span");
      empty.className = "list-empty";
      empty.textContent = "出店者なし";
      body.appendChild(empty);
    }

    row.appendChild(body);
    row.addEventListener("click", () => openDayModal(dateStr));
    wrap.appendChild(row);
  }

  if (shown === 0) {
    const e = document.createElement("div");
    e.className = "fees-empty";
    e.textContent = "この月の出店予定はありません";
    wrap.appendChild(e);
  }
}

/* ---------------- Day modal ---------------- */
function openDayModal(dateStr) {
  state.selectedDate = dateStr;
  const [y, m, d] = dateStr.split("-").map(Number);
  const dow = ["日", "月", "火", "水", "木", "金", "土"][new Date(y, m - 1, d).getDay()];
  $("#day-modal-title").textContent = `${y}年${m}月${d}日（${dow}）`;

  const customHoliday = state.holidays.has(dateStr);
  $("#holiday-toggle").checked = customHoliday;

  renderVendorSelect();
  renderDayVendorList();
  $("#day-modal").hidden = false;
}

function renderVendorSelect() {
  const sel = $("#vendor-select");
  const used = (state.openings[state.selectedDate] || []).map((o) => o.vendor_id);
  sel.innerHTML = "";
  const available = state.vendors.filter((v) => !used.includes(v.id));

  // 先頭は空のプレースホルダ（初期値は未選択）
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = available.length === 0 ? "追加できる出店者がありません" : "出店者を選択して追加…";
  placeholder.disabled = true;
  placeholder.selected = true;
  sel.appendChild(placeholder);

  for (const v of available) {
    const opt = document.createElement("option");
    opt.value = v.id;
    opt.textContent = v.name;
    sel.appendChild(opt);
  }
  sel.disabled = available.length === 0;
}

function renderDayVendorList() {
  const ul = $("#day-vendor-list");
  const list = state.openings[state.selectedDate] || [];
  ul.innerHTML = "";

  if (list.length === 0) {
    const li = document.createElement("li");
    li.className = "chip-empty";
    li.textContent = "まだ出店者がいません";
    ul.appendChild(li);
  } else {
    for (const o of list) {
      const li = document.createElement("li");
      const span = document.createElement("span");
      span.textContent = vendorName(o.vendor_id);
      const btn = document.createElement("button");
      btn.className = "remove";
      btn.textContent = "×";
      btn.title = "削除";
      btn.addEventListener("click", () => removeOpening(o.id));
      li.append(span, btn);
      ul.appendChild(li);
    }
  }

  const hint = $("#day-hint");
  if (list.length >= 2) {
    hint.textContent = list.length >= 3
      ? "⚠️ 3者以上が登録されています。調整が必要です。"
      : "この日は満員（2者）です。さらに追加すると要調整になります。";
  } else {
    hint.textContent = `あと ${2 - list.length} 枠 空いています。`;
  }
}

async function addOpeningToDay() {
  const sel = $("#vendor-select");
  const vendorId = Number(sel.value);
  if (!vendorId) return;
  const date = state.selectedDate;
  const list = state.openings[date] || [];

  if (list.length >= 2) {
    const ok = confirm("この日は既に2者が出店しています。3者以上は「要調整」になります。追加しますか？");
    if (!ok) return;
  }

  const { data, error } = await sb
    .from("openings")
    .insert({ opening_date: date, vendor_id: vendorId })
    .select("id, vendor_id")
    .single();
  if (error) { toast("追加に失敗しました：" + error.message, true); return; }

  (state.openings[date] ||= []).push({ id: data.id, vendor_id: data.vendor_id });
  renderDayVendorList();
  renderVendorSelect();
  refreshCalendarViews();
  toast("出店者を追加しました");
}

async function removeOpening(openingId) {
  const { error } = await sb.from("openings").delete().eq("id", openingId);
  if (error) { toast("削除に失敗しました：" + error.message, true); return; }
  const date = state.selectedDate;
  state.openings[date] = (state.openings[date] || []).filter((o) => o.id !== openingId);
  if (state.openings[date].length === 0) delete state.openings[date];
  renderDayVendorList();
  renderVendorSelect();
  refreshCalendarViews();
  toast("削除しました");
}

async function toggleHoliday(checked) {
  const date = state.selectedDate;
  if (checked) {
    const { error } = await sb.from("holidays").upsert({ holiday_date: date }, { onConflict: "holiday_date" });
    if (error) { toast("設定に失敗しました：" + error.message, true); $("#holiday-toggle").checked = false; return; }
    state.holidays.add(date);
    toast("休日に設定しました");
  } else {
    const { error } = await sb.from("holidays").delete().eq("holiday_date", date);
    if (error) { toast("解除に失敗しました：" + error.message, true); $("#holiday-toggle").checked = true; return; }
    state.holidays.delete(date);
    toast("休日設定を解除しました");
  }
  refreshCalendarViews();
}

/* ---------------- Vendor manager ---------------- */
function openVendorModal() {
  renderVendorManageList();
  $("#vendor-modal").hidden = false;
}

function renderVendorManageList() {
  const ul = $("#vendor-manage-list");
  ul.innerHTML = "";
  for (const v of state.vendors) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = v.name;
    const btn = document.createElement("button");
    btn.className = "remove";
    btn.textContent = "削除";
    btn.addEventListener("click", () => deleteVendor(v));
    li.append(span, btn);
    ul.appendChild(li);
  }
}

async function addVendor() {
  const input = $("#new-vendor-name");
  const name = input.value.trim();
  if (!name) return;
  const { data, error } = await sb.from("vendors").insert({ name }).select("id, name").single();
  if (error) {
    toast(error.code === "23505" ? "同名の出店者が既に存在します" : "追加に失敗しました：" + error.message, true);
    return;
  }
  state.vendors.push(data);
  state.vendors.sort((a, b) => a.name.localeCompare(b.name, "ja"));
  input.value = "";
  renderVendorManageList();
  toast("出店者を追加しました");
}

async function deleteVendor(v) {
  if (!confirm(`「${v.name}」を削除しますか？\nこの出店者の出店予定もすべて削除されます。`)) return;
  // 関連する出店予定を先に削除
  await sb.from("openings").delete().eq("vendor_id", v.id);
  const { error } = await sb.from("vendors").delete().eq("id", v.id);
  if (error) { toast("削除に失敗しました：" + error.message, true); return; }
  state.vendors = state.vendors.filter((x) => x.id !== v.id);
  renderVendorManageList();
  await loadMonthData(state.calYear, state.calMonth);
  refreshCalendarViews();
  toast("削除しました");
}

/* ---------------- Fees view ---------------- */
async function renderFees() {
  $("#fee-month-label").textContent = monthLabel(state.feeYear, state.feeMonth);
  const body = $("#fees-body");
  const foot = $("#fees-foot");
  body.innerHTML = "";
  foot.innerHTML = "";

  const { start, end } = monthRange(state.feeYear, state.feeMonth);
  const { data, error } = await sb
    .from("openings")
    .select("vendor_id")
    .gte("opening_date", start)
    .lte("opening_date", end);
  if (error) { toast("読み込みに失敗しました：" + error.message, true); return; }

  const counts = {};
  for (const row of data) counts[row.vendor_id] = (counts[row.vendor_id] || 0) + 1;

  const rows = state.vendors
    .map((v) => ({ v, count: counts[v.id] || 0 }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count);

  if (rows.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 3;
    td.className = "fees-empty";
    td.textContent = "この月の出店記録はありません";
    tr.appendChild(td);
    body.appendChild(tr);
    return;
  }

  let totalCount = 0, totalFee = 0;
  for (const { v, count } of rows) {
    const exempt = isFeeExempt(v.name);
    const billable = Math.min(count, FREE_AFTER);
    const fee = exempt ? 0 : billable * FEE_PER_VISIT;
    totalCount += count;
    totalFee += fee;

    const tr = document.createElement("tr");
    const tdName = document.createElement("td");
    tdName.textContent = v.name;
    if (exempt) {
      const badge = document.createElement("span");
      badge.className = "free-badge";
      badge.textContent = `出店料無料`;
      tdName.appendChild(badge);
    } else if (count > FREE_AFTER) {
      const badge = document.createElement("span");
      badge.className = "free-badge";
      badge.textContent = `4回目以降無料`;
      tdName.appendChild(badge);
    }
    const tdCount = document.createElement("td");
    tdCount.className = "num";
    tdCount.textContent = `${count} 回`;
    const tdFee = document.createElement("td");
    tdFee.className = "num";
    tdFee.textContent = `¥${fee.toLocaleString()}`;
    tr.append(tdName, tdCount, tdFee);
    body.appendChild(tr);
  }

  const tr = document.createElement("tr");
  const l = document.createElement("td"); l.textContent = "合計";
  const c = document.createElement("td"); c.className = "num"; c.textContent = `${totalCount} 回`;
  const f = document.createElement("td"); f.className = "num"; f.textContent = `¥${totalFee.toLocaleString()}`;
  tr.append(l, c, f);
  foot.appendChild(tr);
}

/* ---------------- View switching ---------------- */
function switchView(view) {
  state.view = view;
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === view));
  $("#view-calendar").classList.toggle("active", view === "calendar");
  $("#view-list").classList.toggle("active", view === "list");
  $("#view-fees").classList.toggle("active", view === "fees");
  // カレンダービューはスクロール不要なので画面内に収める（リスト/出店料はスクロール可）
  document.body.classList.toggle("calendar-view", view === "calendar");
  if (view === "fees") renderFees();
  if (view === "list") renderList();
}

/* カレンダーとリストの両方を更新（同じ月データを共有） */
function refreshCalendarViews() {
  renderCalendar();
  if (state.view === "list") renderList();
}

async function changeCalMonth(delta) {
  let m = state.calMonth + delta;
  let y = state.calYear;
  if (m < 0) { m = 11; y--; }
  if (m > 11) { m = 0; y++; }
  state.calYear = y; state.calMonth = m;
  await loadMonthData(y, m);
  refreshCalendarViews();
}

async function goToday() {
  const t = new Date();
  state.calYear = t.getFullYear();
  state.calMonth = t.getMonth();
  await loadMonthData(state.calYear, state.calMonth);
  refreshCalendarViews();
}

function changeFeeMonth(delta) {
  let m = state.feeMonth + delta;
  let y = state.feeYear;
  if (m < 0) { m = 11; y--; }
  if (m > 11) { m = 0; y++; }
  state.feeYear = y; state.feeMonth = m;
  renderFees();
}

/* ---------------- Wiring ---------------- */
function wireEvents() {
  $$(".tab").forEach((t) => t.addEventListener("click", () => switchView(t.dataset.view)));

  $("#prev-month").addEventListener("click", () => changeCalMonth(-1));
  $("#next-month").addEventListener("click", () => changeCalMonth(1));
  $("#today-btn").addEventListener("click", goToday);

  // リストビューのツールバー（カレンダーと同じ月データを共有）
  $("#list-prev-month").addEventListener("click", () => changeCalMonth(-1));
  $("#list-next-month").addEventListener("click", () => changeCalMonth(1));
  $("#list-today-btn").addEventListener("click", goToday);

  $("#fee-prev-month").addEventListener("click", () => changeFeeMonth(-1));
  $("#fee-next-month").addEventListener("click", () => changeFeeMonth(1));

  $("#manage-vendors-btn").addEventListener("click", openVendorModal);
  $("#add-vendor-btn").addEventListener("click", addVendor);
  $("#new-vendor-name").addEventListener("keydown", (e) => { if (e.key === "Enter") addVendor(); });

  // 出店者を選択したら即追加（追加ボタンを廃止しUXを向上）
  $("#vendor-select").addEventListener("change", addOpeningToDay);
  $("#holiday-toggle").addEventListener("change", (e) => toggleHoliday(e.target.checked));

  // モーダルを閉じる
  $$("[data-close]").forEach((b) => b.addEventListener("click", closeModals));
  $$(".modal-overlay").forEach((ov) =>
    ov.addEventListener("click", (e) => { if (e.target === ov) closeModals(); })
  );
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModals(); });
}

function closeModals() {
  $("#day-modal").hidden = true;
  $("#vendor-modal").hidden = true;
}

/* ---------------- Init ---------------- */
async function init() {
  const now = new Date();
  state.calYear = state.feeYear = now.getFullYear();
  state.calMonth = state.feeMonth = now.getMonth();

  document.body.classList.add("calendar-view"); // 初期表示はカレンダー
  wireEvents();

  try {
    await ensureVendors();
    await loadMonthData(state.calYear, state.calMonth);
    renderCalendar();
  } catch (err) {
    console.error(err);
    toast("データベースへの接続に失敗しました。Supabaseの設定（テーブル/RLS）をご確認ください。", true);
    $("#calendar-grid").innerHTML =
      '<div style="grid-column:1/-1;padding:40px;text-align:center;color:#6b6b70;">' +
      "接続エラー：READMEのSupabaseセットアップ手順（supabase_setup.sql の実行）をご確認ください。</div>";
  }
}

document.addEventListener("DOMContentLoaded", init);
