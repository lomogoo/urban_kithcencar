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

const OPENING_COLS = "id, opening_date, vendor_id, fee_free, sales, cancelled";

function normalizeOpening(row) {
  return {
    id: row.id,
    vendor_id: row.vendor_id,
    fee_free: row.fee_free ?? false,
    sales: row.sales ?? null,
    cancelled: row.cancelled ?? false,
  };
}

async function loadMonthData(y, m0) {
  const { start, end } = monthRange(y, m0);

  const [openRes, holRes] = await Promise.all([
    sb.from("openings").select(OPENING_COLS).gte("opening_date", start).lte("opening_date", end).order("opening_date"),
    sb.from("holidays").select("holiday_date").gte("holiday_date", start).lte("holiday_date", end),
  ]);
  if (openRes.error) throw openRes.error;
  if (holRes.error) throw holRes.error;

  const openings = {};
  for (const row of openRes.data) {
    (openings[row.opening_date] ||= []).push(normalizeOpening(row));
  }
  state.openings = openings;
  state.holidays = new Set(holRes.data.map((r) => r.holiday_date));
}

/* 月内の出店を日付順のフラットな配列で取得（料金・Excel計算用） */
async function fetchMonthOpenings(y, m0) {
  const { start, end } = monthRange(y, m0);
  const { data, error } = await sb
    .from("openings")
    .select(OPENING_COLS)
    .gte("opening_date", start)
    .lte("opening_date", end)
    .order("opening_date");
  if (error) throw error;
  return data.map((r) => ({ ...normalizeOpening(r), opening_date: r.opening_date }));
}

/* ---------------- Calendar rendering ---------------- */
/* キャンセルされた出店は枠・料金にカウントしない（表示は残す） */
function activeCount(list) {
  let n = 0;
  for (const o of list) if (!o.cancelled) n++;
  return n;
}

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
        cell.classList.add(statusClass(activeCount(list)));
        appendVendorTags(cell, list);
      } else {
        const tag = document.createElement("div");
        tag.className = "holiday-tag";
        tag.textContent = "休";
        cell.appendChild(tag);
      }
    } else {
      cell.classList.add(statusClass(activeCount(list)));
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
    t.className = "v-tag" + (o.cancelled ? " cancelled" : "");
    t.textContent = vendorName(o.vendor_id);
    if (o.cancelled) t.title = "出店キャンセル";
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

    const statusCls = isHoliday ? "s-holiday" : statusClass(activeCount(list));
    const badge = document.createElement("span");
    badge.className = "list-status " + statusCls;
    badge.textContent = isHoliday ? "休日" : STATUS_LABEL[statusCls];
    body.appendChild(badge);

    if (list.length > 0) {
      const names = document.createElement("div");
      names.className = "list-vendors";
      for (const o of list) {
        const chip = document.createElement("span");
        chip.className = "list-vendor" + (o.cancelled ? " cancelled" : "");
        chip.textContent = o.cancelled ? `${vendorName(o.vendor_id)}（キャンセル）` : vendorName(o.vendor_id);
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
      li.className = "vendor-entry" + (o.cancelled ? " cancelled" : "");

      const head = document.createElement("div");
      head.className = "ve-head";
      const span = document.createElement("span");
      span.className = "ve-name";
      span.textContent = vendorName(o.vendor_id);
      if (o.cancelled) {
        const tag = document.createElement("span");
        tag.className = "ve-cancel-tag";
        tag.textContent = "キャンセル";
        span.appendChild(tag);
      }
      const btn = document.createElement("button");
      btn.className = "remove";
      btn.textContent = "×";
      btn.title = "削除";
      btn.addEventListener("click", () => removeOpening(o.id));
      head.append(span, btn);
      li.appendChild(head);

      // 出店キャンセルトグル（チェックすると請求対象から除外）
      const cancelRow = document.createElement("label");
      cancelRow.className = "ve-row ve-cancel";
      const cc = document.createElement("input");
      cc.type = "checkbox";
      cc.className = "ve-check";
      cc.checked = !!o.cancelled;
      cc.addEventListener("change", () => setOpeningCancelled(o, cc.checked));
      const cancelLabel = document.createElement("span");
      cancelLabel.textContent = "出店をキャンセル（出店料の請求なし）";
      cancelRow.append(cc, cancelLabel);
      li.appendChild(cancelRow);

      // 出店料無料トグル（この日のこの出店者を無料にする）
      const feeRow = document.createElement("label");
      feeRow.className = "ve-row";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "ve-check";
      cb.checked = !!o.fee_free;
      cb.disabled = !!o.cancelled;
      cb.addEventListener("change", () => setOpeningFeeFree(o, cb.checked));
      const feeLabel = document.createElement("span");
      feeLabel.textContent = "この日の出店料を無料にする";
      feeRow.append(cb, feeLabel);
      li.appendChild(feeRow);

      // 売上実績の入力
      const salesRow = document.createElement("div");
      salesRow.className = "ve-row ve-sales";
      const sLabel = document.createElement("span");
      sLabel.textContent = "売上実績";
      const sInput = document.createElement("input");
      sInput.type = "number";
      sInput.inputMode = "numeric";
      sInput.min = "0";
      sInput.step = "1";
      sInput.placeholder = "未入力";
      sInput.className = "ve-sales-input";
      sInput.value = o.sales == null ? "" : o.sales;
      const yen = document.createElement("span");
      yen.className = "ve-yen";
      yen.textContent = "円";
      const save = () => setOpeningSales(o, sInput.value);
      sInput.addEventListener("change", save);
      sInput.addEventListener("blur", save);
      salesRow.append(sLabel, sInput, yen);
      li.appendChild(salesRow);

      ul.appendChild(li);
    }
  }

  const hint = $("#day-hint");
  const active = activeCount(list);
  if (active >= 2) {
    hint.textContent = active >= 3
      ? "⚠️ 3者以上が登録されています。調整が必要です。"
      : "この日は満員（2者）です。さらに追加すると要調整になります。";
  } else {
    hint.textContent = `あと ${2 - active} 枠 空いています。`;
  }
}

async function setOpeningCancelled(opening, checked) {
  const prev = opening.cancelled;
  opening.cancelled = checked;
  const { error } = await sb.from("openings").update({ cancelled: checked }).eq("id", opening.id);
  if (error) {
    opening.cancelled = prev;
    renderDayVendorList();
    toast("更新に失敗しました：" + error.message, true);
    return;
  }
  renderDayVendorList();
  refreshCalendarViews();
  toast(checked ? "出店をキャンセルにしました（請求対象外）" : "キャンセルを解除しました");
}

async function setOpeningFeeFree(opening, checked) {
  const prev = opening.fee_free;
  opening.fee_free = checked;
  const { error } = await sb.from("openings").update({ fee_free: checked }).eq("id", opening.id);
  if (error) {
    opening.fee_free = prev;
    renderDayVendorList();
    toast("更新に失敗しました：" + error.message, true);
    return;
  }
  toast(checked ? "出店料を無料にしました" : "通常料金に戻しました");
}

async function setOpeningSales(opening, raw) {
  const trimmed = String(raw).trim();
  const value = trimmed === "" ? null : Math.max(0, Math.round(Number(trimmed)));
  if (value != null && !Number.isFinite(value)) { toast("売上は数値で入力してください", true); return; }
  if (value === opening.sales) return; // 変化なし
  const prev = opening.sales;
  opening.sales = value;
  const { error } = await sb.from("openings").update({ sales: value }).eq("id", opening.id);
  if (error) {
    opening.sales = prev;
    toast("売上の保存に失敗しました：" + error.message, true);
    return;
  }
  toast("売上を保存しました");
}

async function addOpeningToDay() {
  const sel = $("#vendor-select");
  const vendorId = Number(sel.value);
  if (!vendorId) return;
  const date = state.selectedDate;
  const list = state.openings[date] || [];

  if (activeCount(list) >= 2) {
    const ok = confirm("この日は既に2者が出店しています。3者以上は「要調整」になります。追加しますか？");
    if (!ok) return;
  }

  const { data, error } = await sb
    .from("openings")
    .insert({ opening_date: date, vendor_id: vendorId })
    .select(OPENING_COLS)
    .single();
  if (error) { toast("追加に失敗しました：" + error.message, true); return; }

  (state.openings[date] ||= []).push(normalizeOpening(data));
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

/* ---------------- Fee computation (shared) ----------------
   各出店者の月内の出店を日付順に走査し、1回ごとの料金を決定する。
   ルール：
   - 出店者が常時無料（isFeeExempt）→ 全回0円
   - その回が fee_free（無料募集日）→ 0円。かつ「課金回数」にカウントしない
   - 通常回は4回目（FREE_AFTER超）から無料
   返り値：vendorId -> { count, fee, perVisit:[{date, fee, free}] }
*/
function computeFees(openingsFlat) {
  const byVendor = new Map();
  for (const o of openingsFlat) {
    if (!byVendor.has(o.vendor_id)) byVendor.set(o.vendor_id, []);
    byVendor.get(o.vendor_id).push(o);
  }

  const result = new Map();
  for (const [vendorId, all] of byVendor) {
    // キャンセル分は出店回数・請求の対象外（除外して集計）
    const list = all.filter((o) => !o.cancelled);
    list.sort((a, b) => a.opening_date.localeCompare(b.opening_date));
    const exempt = isFeeExempt(vendorName(vendorId));
    let billableSoFar = 0;
    let fee = 0;
    const perVisit = [];
    for (const o of list) {
      let visitFee = 0;
      let free = true;
      if (exempt || o.fee_free) {
        visitFee = 0; // 課金回数にカウントしない
      } else if (billableSoFar < FREE_AFTER) {
        visitFee = FEE_PER_VISIT;
        billableSoFar++;
        free = false;
      } // else: 4回目以降は無料
      fee += visitFee;
      perVisit.push({ date: o.opening_date, fee: visitFee, free });
    }
    result.set(vendorId, { count: list.length, fee, perVisit, exempt });
  }
  return result;
}

/* ---------------- Fees view ---------------- */
async function renderFees() {
  $("#fee-month-label").textContent = monthLabel(state.feeYear, state.feeMonth);
  const body = $("#fees-body");
  const foot = $("#fees-foot");
  body.innerHTML = "";
  foot.innerHTML = "";

  let openingsFlat;
  try {
    openingsFlat = await fetchMonthOpenings(state.feeYear, state.feeMonth);
  } catch (err) {
    toast("読み込みに失敗しました：" + err.message, true);
    return;
  }

  const fees = computeFees(openingsFlat);
  const rows = state.vendors
    .map((v) => ({ v, info: fees.get(v.id) }))
    .filter((r) => r.info && r.info.count > 0)
    .sort((a, b) => b.info.count - a.info.count);

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
  for (const { v, info } of rows) {
    const freeCount = info.perVisit.filter((p) => p.free).length;
    totalCount += info.count;
    totalFee += info.fee;

    const tr = document.createElement("tr");
    const tdName = document.createElement("td");
    tdName.textContent = v.name;
    if (info.exempt) {
      tdName.appendChild(makeBadge("出店料無料"));
    } else if (freeCount > 0) {
      tdName.appendChild(makeBadge(`無料 ${freeCount}回`));
    }
    const tdCount = document.createElement("td");
    tdCount.className = "num";
    tdCount.textContent = `${info.count} 回`;
    const tdFee = document.createElement("td");
    tdFee.className = "num";
    tdFee.textContent = `¥${info.fee.toLocaleString()}`;
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

function makeBadge(text) {
  const badge = document.createElement("span");
  badge.className = "free-badge";
  badge.textContent = text;
  return badge;
}

/* ---------------- Lazy script loader（出力ライブラリは押下時のみ読込） ---------------- */
const _loadedScripts = {};
function loadScript(src) {
  if (_loadedScripts[src]) return _loadedScripts[src];
  _loadedScripts[src] = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => { delete _loadedScripts[src]; reject(new Error("読み込み失敗: " + src)); };
    document.head.appendChild(s);
  });
  return _loadedScripts[src];
}

const CDN = {
  html2canvas: "https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js",
  jspdf: "https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js",
  xlsx: "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js",
  docx: "https://cdn.jsdelivr.net/npm/docx@7.8.2/build/index.js",
};

/* 出力用に、店名を完全表示（改行可）・ステータスバー無しのクローンを生成 */
function buildPrintable(kind) {
  const root = document.createElement("div");
  root.className = "print-root";
  const title = document.createElement("h2");
  title.className = "print-title";
  title.textContent = `アーバンネット 出店スケジュール ${monthLabel(state.calYear, state.calMonth)}` +
    (kind === "list" ? "（リスト）" : "（カレンダー）");
  root.appendChild(title);
  root.appendChild(kind === "list" ? buildPrintableList() : buildPrintableCalendar());
  return root;
}

function buildPrintableCalendar() {
  const y = state.calYear, m0 = state.calMonth;
  const firstDow = new Date(y, m0, 1).getDay();
  const daysInMonth = new Date(y, m0 + 1, 0).getDate();
  const dows = ["日", "月", "火", "水", "木", "金", "土"];

  const table = document.createElement("table");
  table.className = "print-cal";
  const thead = document.createElement("thead");
  const htr = document.createElement("tr");
  for (let i = 0; i < 7; i++) {
    const th = document.createElement("th");
    th.textContent = dows[i];
    if (i === 0) th.className = "sun";
    if (i === 6) th.className = "sat";
    htr.appendChild(th);
  }
  thead.appendChild(htr);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  let tr = document.createElement("tr");
  for (let i = 0; i < firstDow; i++) tr.appendChild(document.createElement("td"));

  for (let d = 1; d <= daysInMonth; d++) {
    if ((firstDow + d - 1) % 7 === 0 && d !== 1) { tbody.appendChild(tr); tr = document.createElement("tr"); }
    const dateStr = ymd(y, m0, d);
    const dow = dayOfWeek(y, m0, d);
    const weekend = dow === 0 || dow === 6;
    const isHoliday = state.holidays.has(dateStr) || JP_HOLIDAYS.has(dateStr) || weekend;
    const list = state.openings[dateStr] || [];

    const td = document.createElement("td");
    if (isHoliday) td.className = "holiday";
    const dnum = document.createElement("div");
    dnum.className = "pc-date";
    dnum.textContent = d;
    td.appendChild(dnum);
    if (isHoliday && list.length === 0) {
      const h = document.createElement("div");
      h.className = "pc-holiday";
      h.textContent = "休";
      td.appendChild(h);
    }
    for (const o of list) {
      const v = document.createElement("div");
      v.className = "pc-vendor" + (o.cancelled ? " cancelled" : "");
      v.textContent = o.cancelled ? `${vendorName(o.vendor_id)}（キャンセル）` : vendorName(o.vendor_id); // 改行可・完全表示
      td.appendChild(v);
    }
    tr.appendChild(td);
  }
  while (tr.children.length < 7) tr.appendChild(document.createElement("td"));
  tbody.appendChild(tr);
  table.appendChild(tbody);
  return table;
}

function buildPrintableList() {
  const y = state.calYear, m0 = state.calMonth;
  const daysInMonth = new Date(y, m0 + 1, 0).getDate();
  const dows = ["日", "月", "火", "水", "木", "金", "土"];

  const table = document.createElement("table");
  table.className = "print-list";
  const tbody = document.createElement("tbody");

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = ymd(y, m0, d);
    const dow = dayOfWeek(y, m0, d);
    const weekend = dow === 0 || dow === 6;
    const isHoliday = state.holidays.has(dateStr) || JP_HOLIDAYS.has(dateStr) || weekend;
    const list = state.openings[dateStr] || [];
    if (isHoliday && list.length === 0) continue;

    const tr = document.createElement("tr");
    const tdDate = document.createElement("td");
    tdDate.className = "pl-date";
    tdDate.textContent = `${m0 + 1}/${d}（${dows[dow]}）`;
    const tdStatus = document.createElement("td");
    tdStatus.className = "pl-status";
    tdStatus.textContent = isHoliday ? "休日" : (STATUS_LABEL[statusClass(activeCount(list))] || "");
    const tdVendors = document.createElement("td");
    tdVendors.className = "pl-vendors";
    tdVendors.textContent = list.length
      ? list.map((o) => (o.cancelled ? `${vendorName(o.vendor_id)}（キャンセル）` : vendorName(o.vendor_id))).join("、")
      : (isHoliday ? "" : "出店者なし");
    tr.append(tdDate, tdStatus, tdVendors);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

/* オフスクリーンに描画してhtml2canvasでcanvas化 */
async function renderPrintableToCanvas(kind) {
  await loadScript(CDN.html2canvas);
  const holder = document.createElement("div");
  holder.className = "print-holder";
  holder.appendChild(buildPrintable(kind));
  document.body.appendChild(holder);
  try {
    const canvas = await window.html2canvas(holder.firstChild, { scale: 2, backgroundColor: "#ffffff", logging: false });
    return canvas;
  } finally {
    holder.remove();
  }
}

function exportFileName(kind, ext) {
  return `アーバンネット_${state.calYear}年${state.calMonth + 1}月_${kind === "list" ? "リスト" : "カレンダー"}.${ext}`;
}

async function exportImage(kind) {
  toast("画像を生成中…");
  try {
    const canvas = await renderPrintableToCanvas(kind);
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = exportFileName(kind, "png");
    a.click();
    toast("画像を出力しました");
  } catch (err) {
    toast("画像の出力に失敗しました：" + err.message, true);
  }
}

async function exportPDF(kind) {
  toast("PDFを生成中…");
  try {
    const canvas = await renderPrintableToCanvas(kind);
    await loadScript(CDN.jspdf);
    const { jsPDF } = window.jspdf;
    const imgData = canvas.toDataURL("image/png");
    const portrait = canvas.height >= canvas.width;
    const pdf = new jsPDF({ orientation: portrait ? "p" : "l", unit: "mm", format: "a4" });
    const pw = pdf.internal.pageSize.getWidth();
    const ph = pdf.internal.pageSize.getHeight();
    const margin = 8;
    const maxW = pw - margin * 2, maxH = ph - margin * 2;
    let w = maxW, h = (canvas.height / canvas.width) * w;
    if (h > maxH) { h = maxH; w = (canvas.width / canvas.height) * h; }
    pdf.addImage(imgData, "PNG", (pw - w) / 2, margin, w, h);
    pdf.save(exportFileName(kind, "pdf"));
    toast("PDFを出力しました");
  } catch (err) {
    toast("PDFの出力に失敗しました：" + err.message, true);
  }
}

async function exportFeesExcel() {
  toast("Excelを生成中…");
  try {
    const openingsFlat = await fetchMonthOpenings(state.feeYear, state.feeMonth);
    const fees = computeFees(openingsFlat);
    await loadScript(CDN.xlsx);
    const XLSX = window.XLSX;

    const rows = state.vendors
      .map((v) => ({ v, info: fees.get(v.id) }))
      .filter((r) => r.info && r.info.count > 0)
      .sort((a, b) => b.info.count - a.info.count);

    const fmtDate = (iso) => {
      const [yy, mm, dd] = iso.split("-").map(Number);
      return `${yy}/${mm}/${dd}`;
    };

    // A:出店者名 / B:出店日 / C:その日の出店料（税別） / D:合計請求額（税別）
    const header = ["出店者", "出店日", "出店料（税別）", "合計請求額（税別）"];
    const aoa = [header];
    const merges = [];
    let grandTotal = 0;

    for (const { v, info } of rows) {
      const start = aoa.length; // この出店者の最初の行
      const visits = info.perVisit; // 出店回数分（キャンセルは除外済み・日付順）
      visits.forEach((pv, i) => {
        aoa.push([
          i === 0 ? v.name : "",
          fmtDate(pv.date),
          pv.fee,
          i === 0 ? info.fee : "",
        ]);
      });
      // 出店者名（A列）と合計請求額（D列）は出店者ごとに縦結合
      if (visits.length > 1) {
        const end = start + visits.length - 1;
        merges.push({ s: { r: start, c: 0 }, e: { r: end, c: 0 } });
        merges.push({ s: { r: start, c: 3 }, e: { r: end, c: 3 } });
      }
      grandTotal += info.fee;
    }

    // 末尾に総合計行
    aoa.push(["合計", "", "", grandTotal]);

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!merges"] = merges;
    ws["!cols"] = [{ wch: 28 }, { wch: 14 }, { wch: 16 }, { wch: 18 }];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, `${state.feeYear}年${state.feeMonth + 1}月`);
    XLSX.writeFile(wb, `アーバンネット_出店料_${state.feeYear}年${state.feeMonth + 1}月.xlsx`);
    toast("Excelを出力しました");
  } catch (err) {
    toast("Excelの出力に失敗しました：" + err.message, true);
  }
}

/* ---------------- 業務完了報告書（Word）出力 ---------------- */
const REPORT_DOWS = ["日", "月", "火", "水", "木", "金", "土"];

/* 表示中の月（カレンダー／リストと同じ）から報告書用データを組み立てる */
function buildReportData() {
  const y = state.calYear, m0 = state.calMonth;
  const month = m0 + 1;
  const lastDay = new Date(y, m0 + 1, 0).getDate();

  // 出店者が存在する日を日付順に収集（キャンセル分は出店日・台数・内訳から除外）
  const days = [];
  for (let d = 1; d <= lastDay; d++) {
    const list = state.openings[ymd(y, m0, d)] || [];
    const active = list.filter((o) => !o.cancelled);
    if (active.length === 0) continue;
    days.push({
      d,
      dow: dayOfWeek(y, m0, d),
      names: active.map((o) => vendorName(o.vendor_id)),
    });
  }

  const openDays = days.length; // 【出店日】出店者が存在している日数
  const totalVisits = days.reduce((s, x) => s + x.names.length, 0); // 【出店台数】当月の延べ出店回数
  const breakdown = days.map(
    (x) => `${month}月${x.d}日(${REPORT_DOWS[x.dow]}): ${x.names.join("、")}`
  );

  return {
    year: y,
    month,
    lastDay,
    subject: `${y}年${month}月アーバンネット仙台中央ビル　平日キッチンカー出店`,
    period: `${y}年${month}月1日～${lastDay}日`,
    workHours: "平日11時～14時",
    openDays,
    totalVisits,
    breakdown,
  };
}

async function exportReportWord() {
  toast("業務完了報告書を生成中…");
  try {
    const r = buildReportData();
    await loadScript(CDN.docx);
    const D = window.docx;
    const {
      Document, Packer, Paragraph, TextRun, AlignmentType,
      Table, TableRow, TableCell, WidthType, BorderStyle, VerticalAlign,
    } = D;

    const FONT = "游ゴシック";

    const run = (text, opts = {}) => new TextRun({ text, font: FONT, ...opts });
    const para = (text, opts = {}) => {
      const { alignment, spacing, ...runOpts } = opts;
      return new Paragraph({
        alignment,
        spacing,
        children: text === "" ? [] : [run(text, runOpts)],
      });
    };

    // 罫線スタイル（業務内容欄の表）
    const thinBorder = { style: BorderStyle.SINGLE, size: 4, color: "000000" };
    const cellBorders = {
      top: thinBorder, bottom: thinBorder, left: thinBorder, right: thinBorder,
    };

    const labelCell = (label) =>
      new TableCell({
        width: { size: 20, type: WidthType.PERCENTAGE },
        borders: cellBorders,
        verticalAlign: VerticalAlign.CENTER,
        children: [para(label, { bold: true })],
      });
    const valueCell = (children) =>
      new TableCell({
        width: { size: 80, type: WidthType.PERCENTAGE },
        borders: cellBorders,
        verticalAlign: VerticalAlign.CENTER,
        children,
      });

    // 業務内容セルの中身
    const contentParas = [
      para(`【出店日】${r.openDays}日間　【出店台数】${r.totalVisits}台`),
      para("内訳："),
      ...r.breakdown.map((line) => para(line)),
    ];

    const infoTable = new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({ children: [labelCell("件　名"), valueCell([para(r.subject)])] }),
        new TableRow({ children: [labelCell("業務期間"), valueCell([para(r.period)])] }),
        new TableRow({ children: [labelCell("業務時間"), valueCell([para(r.workHours)])] }),
        new TableRow({ children: [labelCell("業務内容"), valueCell(contentParas)] }),
        new TableRow({ children: [labelCell("特記事項"), valueCell([para("")])] }),
      ],
    });

    const doc = new Document({
      // フォントサイズ（half-point）：その他=9pt(18)・宛名=11pt(22)・見出し=12pt(24)
      styles: { default: { document: { run: { font: FONT, size: 18 } } } },
      sections: [
        {
          children: [
            // 宛名（そのまま）11pt
            para("NTT都市開発株式会社　御中", { size: 22, bold: true }),
            para(""),
            // 差出人（右寄せ・そのまま）
            para("株式会社ユーメディア", { alignment: AlignmentType.RIGHT }),
            para("〒984-8545", { alignment: AlignmentType.RIGHT }),
            para("宮城県仙台市若林区土樋103", { alignment: AlignmentType.RIGHT }),
            para("営業担当：吉田陸人", { alignment: AlignmentType.RIGHT }),
            para(""),
            // タイトル＝見出し（そのまま）12pt
            para("業務完了報告書", {
              alignment: AlignmentType.CENTER,
              size: 24,
              bold: true,
              spacing: { before: 120, after: 240 },
            }),
            para("上記のとおり業務を完了いたしました。", { spacing: { after: 240 } }),
            infoTable,
          ],
        },
      ],
    });

    const blob = await Packer.toBlob(doc);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `アーバンネット_業務完了報告書_${r.year}年${r.month}月.docx`;
    a.click();
    URL.revokeObjectURL(url);
    toast("業務完了報告書を出力しました");
  } catch (err) {
    toast("業務完了報告書の出力に失敗しました：" + err.message, true);
  }
}

/* ---------------- Sales analytics view ---------------- */
async function renderAnalytics() {
  $("#analytics-month-label").textContent = monthLabel(state.calYear, state.calMonth);
  const wrap = $("#analytics-container");
  wrap.innerHTML = '<div class="fees-empty">集計中…</div>';

  const y = state.calYear, m0 = state.calMonth;
  const pm = m0 === 0 ? 11 : m0 - 1;
  const py = m0 === 0 ? y - 1 : y;

  let cur, prev;
  try {
    [cur, prev] = await Promise.all([fetchMonthOpenings(y, m0), fetchMonthOpenings(py, pm)]);
  } catch (err) {
    wrap.innerHTML = `<div class="fees-empty">読み込みに失敗しました：${err.message}</div>`;
    return;
  }

  // 出店者ごとの平均売上（売上入力のある回のみを母数にする）
  const avgByVendor = (openings) => {
    const acc = new Map(); // vendor_id -> {sum, n}
    for (const o of openings) {
      if (o.cancelled) continue; // キャンセル分は売上分析の対象外
      if (o.sales == null) continue;
      if (!acc.has(o.vendor_id)) acc.set(o.vendor_id, { sum: 0, n: 0 });
      const a = acc.get(o.vendor_id);
      a.sum += o.sales; a.n++;
    }
    const out = new Map();
    for (const [id, a] of acc) out.set(id, { avg: a.sum / a.n, n: a.n });
    return out;
  };

  const curAvg = avgByVendor(cur);
  const prevAvg = avgByVendor(prev);

  // 全体平均（出店者平均の平均）
  const overall = (map) => {
    if (map.size === 0) return null;
    let s = 0; for (const { avg } of map.values()) s += avg;
    return s / map.size;
  };
  const curOverall = overall(curAvg);
  const prevOverall = overall(prevAvg);

  wrap.innerHTML = "";

  // サマリーカード：今月平均 vs 先月平均
  const summary = document.createElement("div");
  summary.className = "analytics-summary";
  summary.appendChild(metricCard("今月の平均売上", curOverall));
  summary.appendChild(metricCard("先月の平均売上", prevOverall));
  const diff = (curOverall != null && prevOverall != null) ? curOverall - prevOverall : null;
  summary.appendChild(metricCard("前月差", diff, true));
  wrap.appendChild(summary);

  // 出店者別：今月平均・先月平均・差異
  const ids = new Set([...curAvg.keys(), ...prevAvg.keys()]);
  if (ids.size === 0) {
    const e = document.createElement("div");
    e.className = "fees-empty";
    e.textContent = "売上実績がまだ入力されていません。日付セルから各出店者の売上を入力してください。";
    wrap.appendChild(e);
    return;
  }

  const card = document.createElement("div");
  card.className = "analytics-card glass";
  const table = document.createElement("table");
  table.className = "analytics-table";
  table.innerHTML =
    "<thead><tr><th>出店者</th><th class='num'>今月平均</th><th class='num'>先月平均</th><th class='num'>差異</th></tr></thead>";
  const tbody = document.createElement("tbody");

  const list = [...ids].map((id) => {
    const c = curAvg.get(id), p = prevAvg.get(id);
    return { id, cur: c ? c.avg : null, prev: p ? p.avg : null };
  }).sort((a, b) => (b.cur ?? -1) - (a.cur ?? -1));

  for (const r of list) {
    const tr = document.createElement("tr");
    const name = document.createElement("td");
    name.textContent = vendorName(r.id);
    const tc = document.createElement("td"); tc.className = "num"; tc.textContent = yen(r.cur);
    const tp = document.createElement("td"); tp.className = "num"; tp.textContent = yen(r.prev);
    const td = document.createElement("td"); td.className = "num";
    if (r.cur != null && r.prev != null) {
      const d = r.cur - r.prev;
      td.textContent = (d >= 0 ? "+" : "−") + "¥" + Math.abs(Math.round(d)).toLocaleString();
      td.classList.add(d >= 0 ? "pos" : "neg");
      // 差異バー
      const bar = document.createElement("div");
      bar.className = "diff-bar " + (d >= 0 ? "pos" : "neg");
      const pct = r.prev > 0 ? Math.min(100, Math.abs(d) / r.prev * 100) : 100;
      bar.style.width = pct + "%";
      td.appendChild(bar);
    } else {
      td.textContent = "—";
    }
    tr.append(name, tc, tp, td);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  card.appendChild(table);
  wrap.appendChild(card);
}

function yen(v) { return v == null ? "—" : "¥" + Math.round(v).toLocaleString(); }

function metricCard(label, value, signed = false) {
  const c = document.createElement("div");
  c.className = "metric-card glass";
  const l = document.createElement("div"); l.className = "metric-label"; l.textContent = label;
  const v = document.createElement("div"); v.className = "metric-value";
  if (value == null) { v.textContent = "—"; }
  else if (signed) {
    v.textContent = (value >= 0 ? "+" : "−") + "¥" + Math.abs(Math.round(value)).toLocaleString();
    v.classList.add(value >= 0 ? "pos" : "neg");
  } else {
    v.textContent = "¥" + Math.round(value).toLocaleString();
  }
  c.append(l, v);
  return c;
}

/* ---------------- Sales analytics PDF export ---------------- */
async function exportAnalyticsPDF() {
  toast("PDFを生成中…");
  try {
    const y = state.calYear, m0 = state.calMonth;
    const pm = m0 === 0 ? 11 : m0 - 1;
    const py = m0 === 0 ? y - 1 : y;

    let cur, prev;
    [cur, prev] = await Promise.all([fetchMonthOpenings(y, m0), fetchMonthOpenings(py, pm)]);

    const avgByVendor = (openings) => {
      const acc = new Map();
      for (const o of openings) {
        if (o.sales == null) continue;
        if (!acc.has(o.vendor_id)) acc.set(o.vendor_id, { sum: 0, n: 0 });
        const a = acc.get(o.vendor_id);
        a.sum += o.sales; a.n++;
      }
      const out = new Map();
      for (const [id, a] of acc) out.set(id, { avg: a.sum / a.n, n: a.n });
      return out;
    };

    const curAvg = avgByVendor(cur);
    const prevAvg = avgByVendor(prev);

    const overall = (map) => {
      if (map.size === 0) return null;
      let s = 0; for (const { avg } of map.values()) s += avg;
      return s / map.size;
    };
    const curOverall = overall(curAvg);
    const prevOverall = overall(prevAvg);

    await loadScript(CDN.jspdf);
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: "p", unit: "mm", format: "a4" });

    // フォント設定（latin文字は標準フォントで代替、日本語はUnicode埋め込みが必要なため
    // html要素のキャプチャ方式ではなくjsPDF autoTableで描画）
    // jsPDF標準フォントは日本語非対応なので、テキストをcanvasに描画してから埋め込む方式を使う

    const PW = doc.internal.pageSize.getWidth();   // 210mm
    const PH = doc.internal.pageSize.getHeight();  // 297mm
    const ML = 14, MR = 14, MT = 14;
    const CW = PW - ML - MR;

    // ---- ヘルパー: キャンバスにテキストを描いてPDFに画像として追加 ----
    let curY = MT;

    const addTextBlock = (() => {
      // オフスクリーンキャンバスにテキストを描画してdoc.addImageで埋め込む
      // 各ブロックはHTMLdivとして作成しhtml2canvasでラスタライズ
      return null; // 下記の直接描画方式に置き換え
    })();

    // html2canvasを使い、分析UIセクションのコンテンツを描画する
    // まず分析結果の専用printableHTMLを組み立てる
    await loadScript(CDN.html2canvas);

    const printEl = document.createElement("div");
    printEl.style.cssText = `
      position:fixed; left:-9999px; top:0;
      width:794px; background:#fff; color:#111;
      font-family:'Helvetica Neue',Arial,'Hiragino Kaku Gothic ProN','Meiryo',sans-serif;
      font-size:13px; padding:32px;
    `;

    const fmtYen = (v) => v == null ? "—" : "¥" + Math.round(v).toLocaleString();
    const fmtDiff = (v) => {
      if (v == null) return "—";
      return (v >= 0 ? "+" : "−") + "¥" + Math.abs(Math.round(v)).toLocaleString();
    };
    const diffColor = (v) => v == null ? "#555" : v >= 0 ? "#1a7a3a" : "#c0392b";

    // タイトル
    const title = document.createElement("h1");
    title.style.cssText = "font-size:20px;font-weight:700;margin:0 0 24px;border-bottom:2px solid #111;padding-bottom:8px;";
    title.textContent = `${y}年${m0 + 1}月 売上分析レポート`;
    printEl.appendChild(title);

    // ---- セクション1: サマリー ----
    const sec1Title = document.createElement("h2");
    sec1Title.style.cssText = "font-size:14px;font-weight:700;margin:0 0 12px;";
    sec1Title.textContent = "サマリー";
    printEl.appendChild(sec1Title);

    const summaryGrid = document.createElement("div");
    summaryGrid.style.cssText = "display:flex;gap:16px;margin-bottom:28px;";
    const summaryItems = [
      { label: "今月の平均売上", value: fmtYen(curOverall), color: "#111" },
      { label: "先月の平均売上", value: fmtYen(prevOverall), color: "#111" },
      {
        label: "前月差",
        value: fmtDiff(curOverall != null && prevOverall != null ? curOverall - prevOverall : null),
        color: diffColor(curOverall != null && prevOverall != null ? curOverall - prevOverall : null),
      },
    ];
    for (const item of summaryItems) {
      const card = document.createElement("div");
      card.style.cssText = "flex:1;border:1px solid #ccc;border-radius:8px;padding:16px;text-align:center;";
      card.innerHTML = `<div style="font-size:11px;color:#666;margin-bottom:6px;">${item.label}</div>
        <div style="font-size:22px;font-weight:700;color:${item.color};">${item.value}</div>`;
      summaryGrid.appendChild(card);
    }
    printEl.appendChild(summaryGrid);

    // ---- セクション2: 出店者別比較 ----
    const sec2Title = document.createElement("h2");
    sec2Title.style.cssText = "font-size:14px;font-weight:700;margin:0 0 12px;";
    sec2Title.textContent = "出店者別 今月・先月平均比較";
    printEl.appendChild(sec2Title);

    const ids = new Set([...curAvg.keys(), ...prevAvg.keys()]);
    if (ids.size > 0) {
      const tbl = document.createElement("table");
      tbl.style.cssText = "width:100%;border-collapse:collapse;margin-bottom:28px;font-size:12px;";
      tbl.innerHTML = `<thead><tr style="background:#f0f0f0;">
        <th style="padding:8px;text-align:left;border:1px solid #ccc;">出店者</th>
        <th style="padding:8px;text-align:right;border:1px solid #ccc;">今月平均</th>
        <th style="padding:8px;text-align:right;border:1px solid #ccc;">先月平均</th>
        <th style="padding:8px;text-align:right;border:1px solid #ccc;">差異</th>
      </tr></thead>`;
      const tbody = document.createElement("tbody");
      const vendorList = [...ids].map((id) => {
        const c = curAvg.get(id), p = prevAvg.get(id);
        return { id, cur: c ? c.avg : null, prev: p ? p.avg : null };
      }).sort((a, b) => (b.cur ?? -1) - (a.cur ?? -1));
      for (const r of vendorList) {
        const d = r.cur != null && r.prev != null ? r.cur - r.prev : null;
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td style="padding:7px 8px;border:1px solid #ccc;">${vendorName(r.id)}</td>
          <td style="padding:7px 8px;text-align:right;border:1px solid #ccc;">${fmtYen(r.cur)}</td>
          <td style="padding:7px 8px;text-align:right;border:1px solid #ccc;">${fmtYen(r.prev)}</td>
          <td style="padding:7px 8px;text-align:right;border:1px solid #ccc;color:${diffColor(d)};font-weight:600;">${fmtDiff(d)}</td>
        `;
        tbody.appendChild(tr);
      }
      tbl.appendChild(tbody);
      printEl.appendChild(tbl);
    } else {
      const empty = document.createElement("p");
      empty.style.cssText = "color:#888;margin-bottom:28px;";
      empty.textContent = "売上実績が入力されていません。";
      printEl.appendChild(empty);
    }

    // ---- セクション3: 出店日別 売上実績（先月平均との比較） ----
    const sec3Title = document.createElement("h2");
    sec3Title.style.cssText = "font-size:14px;font-weight:700;margin:0 0 12px;";
    sec3Title.textContent = "出店日別 売上実績（出店者ごとの先月平均との比較）";
    printEl.appendChild(sec3Title);

    // curを日付でグループ化
    const DOW_LABELS = ["日", "月", "火", "水", "木", "金", "土"];
    const byDate = new Map();
    for (const o of cur) {
      if (!byDate.has(o.opening_date)) byDate.set(o.opening_date, []);
      byDate.get(o.opening_date).push(o);
    }
    const sortedDates = [...byDate.keys()].sort();

    if (sortedDates.length === 0) {
      const empty = document.createElement("p");
      empty.style.cssText = "color:#888;";
      empty.textContent = "今月の出店記録がありません。";
      printEl.appendChild(empty);
    } else {
      const dateTbl = document.createElement("table");
      dateTbl.style.cssText = "width:100%;border-collapse:collapse;font-size:12px;";
      dateTbl.innerHTML = `<thead><tr style="background:#f0f0f0;">
        <th style="padding:8px;text-align:left;border:1px solid #ccc;white-space:nowrap;">出店日</th>
        <th style="padding:8px;text-align:left;border:1px solid #ccc;">出店者</th>
        <th style="padding:8px;text-align:right;border:1px solid #ccc;">当日売上</th>
        <th style="padding:8px;text-align:right;border:1px solid #ccc;">先月平均</th>
        <th style="padding:8px;text-align:right;border:1px solid #ccc;">差異</th>
      </tr></thead>`;
      const dateTbody = document.createElement("tbody");

      for (const dateStr of sortedDates) {
        const openings = byDate.get(dateStr);
        const d = new Date(dateStr + "T00:00:00");
        const dateLabel = `${m0 + 1}/${d.getDate()}（${DOW_LABELS[d.getDay()]}）`;
        let firstRow = true;
        for (const o of openings) {
          const pAvg = prevAvg.get(o.vendor_id);
          const pVal = pAvg ? pAvg.avg : null;
          const sales = o.sales;
          const diff = sales != null && pVal != null ? sales - pVal : null;
          const tr = document.createElement("tr");
          const bg = firstRow ? "" : "";
          tr.innerHTML = `
            <td style="padding:7px 8px;border:1px solid #ccc;white-space:nowrap;">${firstRow ? dateLabel : ""}</td>
            <td style="padding:7px 8px;border:1px solid #ccc;">${vendorName(o.vendor_id)}</td>
            <td style="padding:7px 8px;text-align:right;border:1px solid #ccc;">${fmtYen(sales)}</td>
            <td style="padding:7px 8px;text-align:right;border:1px solid #ccc;">${fmtYen(pVal)}</td>
            <td style="padding:7px 8px;text-align:right;border:1px solid #ccc;color:${diffColor(diff)};font-weight:600;">${fmtDiff(diff)}</td>
          `;
          dateTbody.appendChild(tr);
          firstRow = false;
        }
      }
      dateTbl.appendChild(dateTbody);
      printEl.appendChild(dateTbl);
    }

    document.body.appendChild(printEl);

    // html2canvasでラスタライズ
    const canvas = await window.html2canvas(printEl, {
      scale: 2,
      useCORS: true,
      backgroundColor: "#ffffff",
      width: printEl.scrollWidth,
      height: printEl.scrollHeight,
    });
    document.body.removeChild(printEl);

    const imgData = canvas.toDataURL("image/png");
    const imgW = canvas.width;
    const imgH = canvas.height;

    // A4 (210×297mm) に収まるよう分割描画
    const pageW = PW - ML - MR;
    const pageH = PH - MT - 10; // bottom margin
    const ratio = pageW / (imgW / 2); // scale: canvas is 2x
    const scaledH = (imgH / 2) * ratio;

    if (scaledH <= pageH) {
      doc.addImage(imgData, "PNG", ML, MT, pageW, scaledH);
    } else {
      // 複数ページに分割
      const pxPerPage = Math.floor((pageH / ratio) * 2); // canvas pixels per page
      let offsetPx = 0;
      while (offsetPx < imgH) {
        if (offsetPx > 0) doc.addPage();
        const sliceH = Math.min(pxPerPage, imgH - offsetPx);
        const sliceCanvas = document.createElement("canvas");
        sliceCanvas.width = imgW;
        sliceCanvas.height = sliceH;
        const ctx = sliceCanvas.getContext("2d");
        ctx.drawImage(canvas, 0, offsetPx, imgW, sliceH, 0, 0, imgW, sliceH);
        const sliceData = sliceCanvas.toDataURL("image/png");
        const sliceScaledH = (sliceH / 2) * ratio;
        doc.addImage(sliceData, "PNG", ML, MT, pageW, sliceScaledH);
        offsetPx += sliceH;
      }
    }

    doc.save(`アーバンネット_売上分析_${y}年${m0 + 1}月.pdf`);
    toast("PDFを出力しました");
  } catch (err) {
    toast("PDFの出力に失敗しました：" + err.message, true);
  }
}

/* ---------------- View switching ---------------- */
function switchView(view) {
  state.view = view;
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === view));
  $("#view-calendar").classList.toggle("active", view === "calendar");
  $("#view-list").classList.toggle("active", view === "list");
  $("#view-fees").classList.toggle("active", view === "fees");
  $("#view-analytics").classList.toggle("active", view === "analytics");
  // カレンダービューはスクロール不要なので画面内に収める（他ビューはスクロール可）
  document.body.classList.toggle("calendar-view", view === "calendar");
  if (view === "fees") renderFees();
  if (view === "list") renderList();
  if (view === "analytics") renderAnalytics();
}

/* カレンダー・リスト・分析を更新（同じ月データを共有） */
function refreshCalendarViews() {
  renderCalendar();
  if (state.view === "list") renderList();
  if (state.view === "analytics") renderAnalytics();
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

  // 分析ビューのツールバー（カレンダーと同じ月を共有）
  $("#analytics-prev-month").addEventListener("click", () => changeCalMonth(-1));
  $("#analytics-next-month").addEventListener("click", () => changeCalMonth(1));

  // 出力ボタン（アイコン）
  $("#cal-export-img").addEventListener("click", () => exportImage("calendar"));
  $("#cal-export-pdf").addEventListener("click", () => exportPDF("calendar"));
  $("#list-export-img").addEventListener("click", () => exportImage("list"));
  $("#list-export-pdf").addEventListener("click", () => exportPDF("list"));
  $("#list-export-report").addEventListener("click", exportReportWord);
  $("#fee-export-xlsx").addEventListener("click", exportFeesExcel);
  $("#analytics-export-pdf").addEventListener("click", exportAnalyticsPDF);

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
