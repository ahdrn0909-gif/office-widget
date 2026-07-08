import { useState, useEffect, useMemo, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  setPersistence,
  browserLocalPersistence,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";
import { doc, getDoc, collection, getDocs, writeBatch, addDoc, deleteDoc, updateDoc, setDoc } from "firebase/firestore";
import KoreanLunarCalendarPkg from "korean-lunar-calendar";
import { auth, db } from "./firebase";
import "./App.css";

const KoreanLunarCalendar = (KoreanLunarCalendarPkg && KoreanLunarCalendarPkg.default) ? KoreanLunarCalendarPkg.default : KoreanLunarCalendarPkg;

const appWindow = getCurrentWindow();
const APP_URL = "https://office-app-plum.vercel.app";
const openCase = (caseId) => { try { openUrl(`${APP_URL}/?case=${encodeURIComponent(caseId)}`); } catch (e) {} };
const openFilter = (special, scope) => {
  const q = scope ? `?filter=${special}&scope=${scope}` : `?filter=${special}`;
  try { openUrl(`${APP_URL}/${q}`); } catch (e) {}
};

/* ===== 유틸 ===== */
const today = () => new Date().toISOString().slice(0, 10);
const pad2 = (n) => String(n).padStart(2, "0");
const dateStr = (dt) => `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
const addDaysStr = (ds, n) => { const dt = new Date(ds + "T00:00:00"); dt.setDate(dt.getDate() + n); return dateStr(dt); };
const ymd = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;
const isValidYMD = (y, m, d) => { const dt = new Date(y, m - 1, d); return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d; };

// 음력 ↔ 양력 변환 (한국천문연구원 기준 라이브러리)
let _klc = null;
function getKlc() { if (!_klc) { try { _klc = new KoreanLunarCalendar(); } catch (e) { _klc = null; } } return _klc; }
function lunarToSolarStr(y, m, d, leap) {
  const c = getKlc(); if (!c) return null;
  try {
    if (!c.setLunarDate(y, m, d, !!leap)) return null;
    const s = c.getSolarCalendar();
    if (!s || !s.year) return null;
    return ymd(s.year, s.month, s.day);
  } catch (e) { return null; }
}
function solarToLunar(ds) {
  const c = getKlc(); if (!c || !ds) return null;
  try {
    const p = ds.split("-").map(Number);
    if (!c.setSolarDate(p[0], p[1], p[2])) return null;
    const l = c.getLunarCalendar();
    if (!l || !l.month) return null;
    return { month: l.month, day: l.day, leap: !!l.intercalation };
  } catch (e) { return null; }
}

// 반복 일정을 창(window) 범위 안에서 실제 날짜들로 펼침
function expandRecurrences(s, winStart, winEnd) {
  const base = s.date;
  if (!base) return [];
  const rep = s.repeat || "none";
  const parts = base.split("-").map(Number);
  const bm = parts[1], bd = parts[2];
  const out = [];
  const sY = Number(winStart.slice(0, 4)), eY = Number(winEnd.slice(0, 4));
  if (rep === "yearly") {
    for (let y = sY; y <= eY; y++) {
      if (isValidYMD(y, bm, bd)) { const ds = ymd(y, bm, bd); if (ds >= winStart && ds <= winEnd) out.push(ds); }
    }
  } else if (rep === "monthly") {
    for (let y = sY; y <= eY; y++) for (let m = 1; m <= 12; m++) {
      if (isValidYMD(y, m, bd)) { const ds = ymd(y, m, bd); if (ds >= winStart && ds <= winEnd) out.push(ds); }
    }
  } else if (rep === "weekly") {
    const baseDate = new Date(base + "T00:00:00");
    const startDate = new Date(winStart + "T00:00:00");
    const k = Math.floor((startDate - baseDate) / 86400000 / 7);
    const occ = new Date(baseDate); occ.setDate(occ.getDate() + k * 7);
    while (dateStr(occ) < winStart) occ.setDate(occ.getDate() + 7);
    let guard = 0;
    while (dateStr(occ) <= winEnd && guard < 600) { out.push(dateStr(occ)); occ.setDate(occ.getDate() + 7); guard++; }
  } else if (rep === "lunar_yearly") {
    const lm = s.lunarMonth, ld = s.lunarDay, ll = !!s.lunarLeap;
    if (lm && ld) {
      for (let y = sY - 1; y <= eY + 1; y++) {
        const ds = lunarToSolarStr(y, lm, ld, ll);
        if (ds && ds >= winStart && ds <= winEnd) out.push(ds);
      }
    }
  }
  return out;
}

function rruleToRepeat(rrule) {
  if (!rrule) return "none";
  const m = /FREQ=([A-Z]+)/.exec(rrule);
  const f = m ? m[1] : "";
  if (f === "YEARLY") return "yearly";
  if (f === "MONTHLY") return "monthly";
  if (f === "WEEKLY") return "weekly";
  return "none";
}
const fmt = (n) => (Number(n) || 0).toLocaleString("ko-KR");
const CASE_NO_MAJORS = ["송무", "회생 파산"];
const INSTALLMENT_METHODS = ["분할납"];
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

// 개인일정 공유 대상별 색상 (네이버 캘린더 느낌) + 사건 색상
const SCHED_COLORS = { private: "#8e8e93", shared: "#64d2ff", team: "#30d158", office: "#bf5af2" };
const DEADLINE_COLOR = "#ff9f0a";
const ACCEPT_COLOR = "#0a84ff";

const DEFAULT_COLOR_RULES = { private: "#0a84ff", office: "#ff5c52", team: "#30d158", sharedRules: [] };
function autoColorFor(visibility, sharedWith, rules) {
  if (!rules) return null;
  if (visibility === "private") return rules.private || null;
  if (visibility === "office") return rules.office || null;
  if (visibility === "team") return rules.team || null;
  if (visibility === "shared") {
    const key = [...(sharedWith || [])].sort().join(",");
    const r = (rules.sharedRules || []).find((rr) => [...(rr.ids || [])].sort().join(",") === key);
    return r ? r.color : null;
  }
  return null;
}

/* ===== 공휴일·대체공휴일 (2025~2027, 인사혁신처 기준) ===== */
const HOLIDAYS = {
  // 2025
  "2025-01-01": "신정",
  "2025-01-27": "임시공휴일",
  "2025-01-28": "설날",
  "2025-01-29": "설날",
  "2025-01-30": "설날",
  "2025-03-01": "삼일절",
  "2025-03-03": "대체공휴일",
  "2025-05-05": "어린이날·부처님오신날",
  "2025-05-06": "대체공휴일",
  "2025-06-03": "대통령선거일",
  "2025-06-06": "현충일",
  "2025-08-15": "광복절",
  "2025-10-03": "개천절",
  "2025-10-05": "추석",
  "2025-10-06": "추석",
  "2025-10-07": "추석",
  "2025-10-08": "대체공휴일",
  "2025-10-09": "한글날",
  "2025-12-25": "크리스마스",
  // 2026
  "2026-01-01": "신정",
  "2026-02-16": "설날",
  "2026-02-17": "설날",
  "2026-02-18": "설날",
  "2026-03-01": "삼일절",
  "2026-03-02": "대체공휴일",
  "2026-05-05": "어린이날",
  "2026-05-24": "부처님오신날",
  "2026-05-25": "대체공휴일",
  "2026-06-06": "현충일",
  "2026-07-17": "제헌절",
  "2026-08-15": "광복절",
  "2026-08-17": "대체공휴일",
  "2026-09-24": "추석",
  "2026-09-25": "추석",
  "2026-09-26": "추석",
  "2026-10-03": "개천절",
  "2026-10-05": "대체공휴일",
  "2026-10-09": "한글날",
  "2026-12-25": "크리스마스",
  // 2027
  "2027-01-01": "신정",
  "2027-02-06": "설날",
  "2027-02-07": "설날",
  "2027-02-08": "설날",
  "2027-02-09": "대체공휴일",
  "2027-03-01": "삼일절",
  "2027-05-05": "어린이날",
  "2027-05-13": "부처님오신날",
  "2027-06-06": "현충일",
  "2027-07-17": "제헌절",
  "2027-07-19": "대체공휴일",
  "2027-08-15": "광복절",
  "2027-08-16": "대체공휴일",
  "2027-09-14": "추석",
  "2027-09-15": "추석",
  "2027-09-16": "추석",
  "2027-10-03": "개천절",
  "2027-10-04": "대체공휴일",
  "2027-10-09": "한글날",
  "2027-10-11": "대체공휴일",
  "2027-12-25": "크리스마스",
  "2027-12-27": "대체공휴일",
};

// 사건 수임일 후보 필드 (필드명이 확실치 않아 유연하게 탐색)
const ACCEPT_DATE_FIELDS = ["receivedDate", "acceptDate", "acceptedDate", "intakeDate", "contractDate", "caseDate", "regDate", "entrustDate", "date"];
function caseAcceptDate(c) {
  for (const f of ACCEPT_DATE_FIELDS) {
    const v = c[f];
    if (typeof v === "string") {
      if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
      if (/^\d{8}$/.test(v)) return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
    }
  }
  return null;
}

// 분할납 미납 판정 (사무실앱과 동일한 이월 로직 간소화)
function isOverdueCase(c) {
  if (!INSTALLMENT_METHODS.includes(c.paymentMethod)) return false;
  const plan = c.paymentPlan;
  if (!plan || !Array.isArray(plan.installments) || plan.installments.length === 0) return false;
  const insts = plan.installments;
  const count = insts.length;
  const total = Number(plan.total) || 0;
  const per = count > 0 ? Math.round(total / count) : 0;
  const now = today();
  let expCum = 0, paidCum = 0, overdue = false;
  insts.forEach((it, i) => {
    const base = i === count - 1 ? total - per * (count - 1) : per;
    expCum += base;
    const hasPaid = it.paidAmount !== null && it.paidAmount !== undefined && it.paidAmount !== "";
    if (hasPaid) paidCum += Number(it.paidAmount) || 0;
    const shortfall = expCum - paidCum;
    const past = it.dueDate && it.dueDate <= now;
    if (past && shortfall > 0) overdue = true;
  });
  return overdue;
}

/* ===== ICS(.ics) 파서 — 네이버 캘린더 내보내기 파일용 ===== */
function unescapeICSText(s) {
  return String(s)
    .replace(/\\n/gi, " ")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .trim();
}

function icsDateParse(val) {
  const m = String(val).match(/(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?/);
  if (!m) return null;
  const Y = m[1], Mo = m[2], D = m[3], H = m[4], Mi = m[5], S = m[6] || "00", Z = m[7];
  if (!H) return { date: `${Y}-${Mo}-${D}`, allDay: true, time: null };
  if (Z) {
    const dt = new Date(Date.UTC(+Y, +Mo - 1, +D, +H, +Mi, +S)); // Z(UTC) → 로컬(KST) 변환
    return { date: dateStr(dt), allDay: false, time: `${pad2(dt.getHours())}:${pad2(dt.getMinutes())}` };
  }
  return { date: `${Y}-${Mo}-${D}`, allDay: false, time: `${H}:${Mi}` };
}

function parseICS(text) {
  // 접힌 줄(다음 줄이 공백/탭으로 시작) 펼치기
  const unfolded = String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n[ \t]/g, "");
  const lines = unfolded.split("\n");
  const raw = [];
  let cur = null;
  for (const line of lines) {
    if (line.indexOf("BEGIN:VEVENT") === 0) { cur = {}; continue; }
    if (line.indexOf("END:VEVENT") === 0) { if (cur) raw.push(cur); cur = null; continue; }
    if (!cur) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const left = line.slice(0, idx);
    const value = line.slice(idx + 1);
    const name = left.split(";")[0].toUpperCase();
    if (name === "SUMMARY") cur.summary = unescapeICSText(value);
    else if (name === "DTSTART") cur.dtstart = value;
    else if (name === "DTEND") cur.dtend = value;
    else if (name === "RRULE") cur.rrule = value;
    else if (name === "DESCRIPTION") cur.description = unescapeICSText(value);
    else if (name === "LOCATION") cur.location = unescapeICSText(value);
  }
  const out = [];
  for (const e of raw) {
    if (!e.dtstart) continue;
    const s = icsDateParse(e.dtstart);
    if (!s) continue;
    let endDate = s.date;
    if (e.dtend) {
      const en = icsDateParse(e.dtend);
      if (en) {
        if (s.allDay) {
          let ed = addDaysStr(en.date, -1); // 종일 일정 DTEND는 배타적 → 하루 빼기
          if (ed < s.date) ed = s.date;
          endDate = ed;
        } else {
          endDate = en.date;
        }
      }
    }
    out.push({
      title: e.summary || "(제목 없음)",
      date: s.date,
      endDate,
      allDay: s.allDay,
      time: s.time || null,
      recurring: !!e.rrule,
      repeat: "none",
      location: e.location || "",
      memo: e.description || "",
    });
  }
  return out;
}

/* ===== 색상 팔레트 (네이버처럼 그룹별 색 지정) ===== */
const PALETTE = ["#bf5af2", "#0a84ff", "#64d2ff", "#30d158", "#40c8b0", "#ff9f0a", "#ff6482", "#ff5c52", "#ffd60a", "#7d7cff", "#ac8e68", "#98989d"];
function ColorPicker({ color, setColor }) {
  return (
    <div className="color-picker">
      {PALETTE.map((c) => (
        <button key={c} type="button" className={"color-sw" + (color === c ? " on" : "")}
          style={{ background: c }} onClick={() => setColor(c)} title={c} />
      ))}
    </div>
  );
}

/* ===== 공유 대상 → 수신자 명단 스냅샷 (생성 시점 고정, 소급효 없음) ===== */
function resolveSharedWith(v, staff, myTeam) {
  const list = staff || [];
  if (v.visibility === "shared") return (v.sharedWith || []).slice();
  if (v.visibility === "office") return list.map((s) => s.id);
  if (v.visibility === "team") {
    const t = v.team || myTeam;
    return list.filter((s) => s.team === t).map((s) => s.id);
  }
  return []; // private
}

/* ===== 공유 대상 선택기 (타입 드롭다운) ===== */
function VisTypeSelect({ v, setV }) {
  const TYPES = [["private", "개인일정"], ["shared", "특정인"], ["office", "회사전체"], ["team", "소속팀원"]];
  return (
    <select className="vis-select" value={v.visibility} onChange={(e) => setV({ ...v, visibility: e.target.value })}>
      {TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
    </select>
  );
}

/* 공유 대상 상세 (특정인 → 직원 선택 / 소속팀원 → 팀 선택) */
function VisDetail({ v, setV, staff, myId, myTeam }) {
  const teams = Array.from(new Set((staff || []).map((s) => s.team).filter(Boolean)));
  const others = (staff || []).filter((s) => s.id !== myId);
  const sw = v.sharedWith || [];
  const nameOf = (id) => ((staff || []).find((s) => s.id === id)?.name) || id;
  const addMember = (id) => { if (id && !sw.includes(id)) setV({ ...v, sharedWith: [...sw, id] }); };
  const removeMember = (id) => setV({ ...v, sharedWith: sw.filter((x) => x !== id) });
  if (v.visibility === "shared") {
    return (
      <div className="vis-members-wrap">
        <select className="vis-select" value="" onChange={(e) => { addMember(e.target.value); e.target.value = ""; }}>
          <option value="">직원 추가…</option>
          {others.filter((s) => !sw.includes(s.id)).map((s) => (
            <option key={s.id} value={s.id}>{s.name || s.id}{s.team ? ` (${s.team})` : ""}</option>
          ))}
        </select>
        {sw.length > 0 && (
          <div className="vis-members">
            {sw.map((id) => (
              <span key={id} className="vis-chip">
                {nameOf(id)}
                <button className="vis-chip-x" onClick={() => removeMember(id)} title="제외">✕</button>
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }
  if (v.visibility === "team") {
    return (
      <select className="vis-select" value={v.team || myTeam || ""} onChange={(e) => setV({ ...v, team: e.target.value })}>
        <option value="">팀 선택</option>
        {teams.map((t) => <option key={t} value={t}>{t} 팀원 전체</option>)}
      </select>
    );
  }
  return null;
}

/* ===== 인라인 비고 편집기 ===== */
function MemoEditor({ scheduleId, initial, onSave }) {
  const [text, setText] = useState(initial || "");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => { setText(initial || ""); setSaved(false); }, [scheduleId, initial]);
  const save = async () => { setBusy(true); await onSave(text.trim()); setBusy(false); setSaved(true); };
  return (
    <div className="memo-edit">
      <textarea className="memo-ta" placeholder="비고 입력 (세부 내용)" value={text}
        onChange={(e) => { setText(e.target.value); setSaved(false); }} />
      <div className="memo-actions">
        <button className="nv-btn primary" onClick={save} disabled={busy}>{busy ? "저장 중..." : "저장"}</button>
        {saved && <span className="memo-saved">저장됨 ✓</span>}
      </div>
    </div>
  );
}

/* ===== 색상 설정 (공유 대상별 고정 색) ===== */
function ColorSettings({ staff, myId, colorRules, onSave }) {
  const [open, setOpen] = useState(false);
  const [rules, setRules] = useState(colorRules || DEFAULT_COLOR_RULES);
  const [newIds, setNewIds] = useState([]);
  const [newColor, setNewColor] = useState("#ff6482");
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (colorRules) setRules(colorRules); }, [colorRules]);
  const nameOf = (id) => ((staff || []).find((s) => s.id === id)?.name) || id;
  const others = (staff || []).filter((s) => s.id !== myId);
  const setField = (k, c) => { setRules((r) => ({ ...r, [k]: c })); setSaved(false); };
  const addMember = (id) => { if (id && !newIds.includes(id)) setNewIds([...newIds, id]); };
  const addRule = () => {
    if (newIds.length === 0) return;
    setRules((r) => ({ ...r, sharedRules: [...(r.sharedRules || []), { ids: newIds, color: newColor }] }));
    setNewIds([]); setSaved(false);
  };
  const removeRule = (i) => { setRules((r) => ({ ...r, sharedRules: (r.sharedRules || []).filter((_, j) => j !== i) })); setSaved(false); };
  const save = async () => { await onSave(rules); setSaved(true); };

  return (
    <div className="nv-import">
      <button className="nv-toggle" onClick={() => setOpen((o) => !o)}>색상 설정 {open ? "▴" : "▾"}</button>
      {open && (
        <div className="nv-box">
          <div className="cs-help">공유 대상별로 색을 정해두면, 일정 만들 때 자동으로 그 색이 적용돼요. (그래도 수동 변경 가능)</div>
          <div className="cs-row"><span className="cs-name">개인일정</span><ColorPicker color={rules.private} setColor={(c) => setField("private", c)} /></div>
          <div className="cs-row"><span className="cs-name">회사전체</span><ColorPicker color={rules.office} setColor={(c) => setField("office", c)} /></div>
          <div className="cs-row"><span className="cs-name">소속팀원</span><ColorPicker color={rules.team} setColor={(c) => setField("team", c)} /></div>

          <div className="cs-label">특정인 색상 규칙</div>
          {(rules.sharedRules || []).length === 0 && <div className="cs-empty">아직 규칙 없음</div>}
          {(rules.sharedRules || []).map((r, i) => (
            <div className="cs-rule" key={i}>
              <span className="cs-swatch" style={{ background: r.color }} />
              <span className="cs-rule-names">{(r.ids || []).map(nameOf).join(", ")}</span>
              <button className="cs-del" onClick={() => removeRule(i)} title="삭제">✕</button>
            </div>
          ))}
          <div className="cs-addbox">
            <select className="vis-select" value="" onChange={(e) => { addMember(e.target.value); e.target.value = ""; }}>
              <option value="">직원 추가…</option>
              {others.filter((s) => !newIds.includes(s.id)).map((s) => (
                <option key={s.id} value={s.id}>{s.name || s.id}{s.team ? ` (${s.team})` : ""}</option>
              ))}
            </select>
            {newIds.length > 0 && (
              <div className="vis-members">
                {newIds.map((id) => (
                  <span key={id} className="vis-chip">{nameOf(id)}<button className="vis-chip-x" onClick={() => setNewIds(newIds.filter((x) => x !== id))}>✕</button></span>
                ))}
              </div>
            )}
            <ColorPicker color={newColor} setColor={setNewColor} />
            <button className="nv-btn" onClick={addRule} disabled={newIds.length === 0}>이 조합 규칙 추가</button>
          </div>

          <div className="msg-actions">
            <button className="nv-btn primary" onClick={save}>설정 저장</button>
            {saved && <span className="memo-saved">저장됨 ✓</span>}
          </div>
        </div>
      )}
    </div>
  );
}

/* ===== 날짜 선택기 (양력 + 음력 작게 표시) ===== */
function DatePicker({ value, onChange, min }) {
  const [open, setOpen] = useState(false);
  const init = value ? new Date(value + "T00:00:00") : new Date();
  const [ym, setYm] = useState({ y: init.getFullYear(), m: init.getMonth() });
  const { y, m } = ym;
  const startWeekday = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let dd = 1; dd <= daysInMonth; dd++) cells.push(dd);
  while (cells.length % 7 !== 0) cells.push(null);
  const todayS = dateStr(new Date());
  const pick = (dd) => {
    const ds = `${y}-${pad2(m + 1)}-${pad2(dd)}`;
    if (min && ds < min) return;
    onChange(ds); setOpen(false);
  };
  return (
    <div className="dp">
      <button type="button" className="dp-field" onClick={() => setOpen((o) => !o)}>
        <span>{value || "날짜 선택"}</span>
        <span className="dp-cal">📅</span>
      </button>
      {open && (
        <div className="dp-pop">
          <div className="dp-nav">
            <span className="dp-nav-g">
              <button type="button" onClick={() => setYm((p) => ({ y: p.y - 1, m: p.m }))} title="이전 해">«</button>
              <button type="button" onClick={() => setYm((p) => (p.m === 0 ? { y: p.y - 1, m: 11 } : { y: p.y, m: p.m - 1 }))} title="이전 달">‹</button>
            </span>
            <span className="dp-nav-t">{y}년 {m + 1}월</span>
            <span className="dp-nav-g">
              <button type="button" onClick={() => setYm((p) => (p.m === 11 ? { y: p.y + 1, m: 0 } : { y: p.y, m: p.m + 1 }))} title="다음 달">›</button>
              <button type="button" onClick={() => setYm((p) => ({ y: p.y + 1, m: p.m }))} title="다음 해">»</button>
            </span>
          </div>
          <div className="dp-wd">
            {WEEKDAYS.map((w, i) => <span key={w} className={i === 0 ? "sun" : i === 6 ? "sat" : ""}>{w}</span>)}
          </div>
          <div className="dp-grid">
            {cells.map((dd, i) => {
              if (dd === null) return <span className="dp-cell empty" key={i} />;
              const ds = `${y}-${pad2(m + 1)}-${pad2(dd)}`;
              const wd = (startWeekday + dd - 1) % 7;
              const hol = HOLIDAYS[ds];
              const lu = solarToLunar(ds);
              const luLabel = lu ? (lu.day === 1 ? `${lu.leap ? "윤" : ""}${lu.month}.1` : `${lu.day}`) : "";
              const disabled = min && ds < min;
              const cls = "dp-cell" + (ds === value ? " sel" : "") + (ds === todayS ? " today" : "") + (disabled ? " disabled" : "");
              return (
                <button type="button" key={i} className={cls} onClick={() => pick(dd)} disabled={disabled}>
                  <span className={"dp-d" + (hol || wd === 0 ? " hol" : wd === 6 ? " sat" : "")}>{dd}</span>
                  <span className="dp-l">{luLabel}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/* ===== 일정 추가/수정 폼 ===== */
function EventForm({ date, myId, staff, myTeam, editDoc, colorRules, onSaved, onCancel }) {
  const init = editDoc || {};
  const [title, setTitle] = useState(init.title || "");
  const [d, setD] = useState(init.date || date);
  const [endD, setEndD] = useState(init.endDate || init.date || date);
  const [allDay, setAllDay] = useState(init.allDay !== undefined ? !!init.allDay : true);
  const [time, setTime] = useState(init.time || "09:00");
  const [repeat, setRepeat] = useState(init.repeat || "none");
  const [memo, setMemo] = useState(init.memo || "");
  const [color, setColor] = useState(init.color || "#0a84ff");
  const [v, setV] = useState({ visibility: init.visibility || "private", sharedWith: init.sharedWith || [], team: init.team || myTeam || "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const skipAutoColor = useRef(!!editDoc);

  // 공유 대상이 바뀌면 저장된 색상 규칙에 따라 색 자동 지정 (수정 진입 시 첫 회는 기존 색 유지)
  useEffect(() => {
    if (skipAutoColor.current) { skipAutoColor.current = false; return; }
    const c = autoColorFor(v.visibility, v.sharedWith, colorRules);
    if (c) setColor(c);
  }, [v.visibility, v.sharedWith]);

  const onStartChange = (val) => { setD(val); if (endD < val) setEndD(val); };

  const save = async () => {
    if (!title.trim()) { setErr("제목을 입력하세요."); return; }
    if (!d) { setErr("날짜를 선택하세요."); return; }
    if (v.visibility === "shared" && (v.sharedWith || []).length === 0) { setErr("공유할 직원을 선택하세요."); return; }
    if (v.visibility === "team" && !(v.team || myTeam)) { setErr("팀을 선택하세요."); return; }
    const lunarInfo = repeat === "lunar_yearly" ? solarToLunar(d) : null;
    if (repeat === "lunar_yearly" && !lunarInfo) { setErr("선택한 날짜를 음력으로 변환할 수 없어요. 다른 날짜를 골라 주세요."); return; }
    setBusy(true); setErr("");
    const endVal = repeat !== "none" ? d : (endD && endD >= d ? endD : d);
    const payload = {
      title: title.trim(),
      date: d,
      endDate: endVal,
      allDay,
      time: allDay ? null : time,
      repeat,
      lunarMonth: lunarInfo ? lunarInfo.month : null,
      lunarDay: lunarInfo ? lunarInfo.day : null,
      lunarLeap: lunarInfo ? !!lunarInfo.leap : false,
      memo: memo.trim(),
      color,
      visibility: v.visibility,
      team: v.visibility === "team" ? (v.team || myTeam) : "",
      sharedWith: resolveSharedWith(v, staff, myTeam),
    };
    try {
      if (editDoc) {
        await updateDoc(doc(db, "office_schedules", editDoc.id), payload);
      } else {
        await addDoc(collection(db, "office_schedules"), { ownerId: myId, ...payload, source: "manual", createdAt: Date.now() });
      }
      if (onSaved) onSaved();
    } catch (e) {
      setErr("저장 오류: " + (e && e.message ? e.message : "알 수 없음"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="add-form">
      <div className="af-title">{editDoc ? "일정 수정" : "일정 추가"}</div>
      <input className="af-input" placeholder="일정 제목" value={title} onChange={(e) => setTitle(e.target.value)} />
      <div className="af-row">
        <DatePicker value={d} onChange={onStartChange} />
        <span className="af-tilde">~</span>
        <DatePicker value={endD} onChange={setEndD} min={d} />
      </div>
      {repeat !== "none" && endD !== d && <div className="af-hint">반복 일정은 시작일 하루만 표시돼요.</div>}
      <VisTypeSelect v={v} setV={setV} />
      <VisDetail v={v} setV={setV} staff={staff} myId={myId} myTeam={myTeam} />
      <div className="af-row">
        <label className="af-check">
          <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} /> 종일
        </label>
        {!allDay && <input className="af-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} />}
      </div>
      <div className="af-color-label">반복</div>
      <select className="vis-select" value={repeat} onChange={(e) => setRepeat(e.target.value)}>
        <option value="none">반복 없음</option>
        <option value="weekly">매주</option>
        <option value="monthly">매월</option>
        <option value="yearly">매년 (양력)</option>
        <option value="lunar_yearly">매년 (음력)</option>
      </select>
      {repeat === "lunar_yearly" && (() => {
        const lu = solarToLunar(d);
        return <div className="af-hint">{lu ? `매년 음력 ${lu.month}월 ${lu.day}일${lu.leap ? " (윤달)" : ""}에 반복돼요` : "이 날짜는 음력 변환 범위를 벗어났어요"}</div>;
      })()}
      <div className="af-color-label">색상</div>
      <ColorPicker color={color} setColor={setColor} />
      <textarea className="af-memo" placeholder="비고 (세부 내용, 선택)" value={memo} onChange={(e) => setMemo(e.target.value)} />
      {err && <div className="af-err">{err}</div>}
      <div className="af-btns">
        <button className="nv-btn primary" onClick={save} disabled={busy}>{busy ? "저장 중..." : (editDoc ? "수정 저장" : "저장")}</button>
        <button className="nv-btn" onClick={onCancel} disabled={busy}>취소</button>
      </div>
    </div>
  );
}

/* ===== 네이버 일정 가져오기 패널 (1회성) ===== */
function NaverImport({ myId, staff, myTeam, onReload }) {
  const ownerId = myId;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const [v, setV] = useState({ visibility: "private", sharedWith: [], team: myTeam || "" });
  const [color, setColor] = useState("#bf5af2");

  const analyze = () => {
    setStatus("");
    const evs = parseICS(text);
    setParsed(evs);
    if (evs.length === 0) setStatus("일정을 찾지 못했어요. .ics 내용을 전체 복사했는지 확인해 주세요.");
  };

  const onFile = (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    let done = 0;
    const all = [];
    let readErr = false;
    files.forEach((f) => {
      const reader = new FileReader();
      reader.onload = () => {
        try { all.push(...parseICS(String(reader.result || ""))); } catch (x) {}
        done++;
        if (done === files.length) finish();
      };
      reader.onerror = () => { readErr = true; done++; if (done === files.length) finish(); };
      reader.readAsText(f, "utf-8");
    });
    const finish = () => {
      // 월별 파일이 겹치거나 반복 일정이 여러 파일에 걸릴 때 중복 제거
      const seen = new Set();
      const uniq = [];
      for (const ev of all) {
        const key = `${ev.date}|${ev.endDate}|${ev.time || ""}|${ev.title}`;
        if (seen.has(key)) continue;
        seen.add(key);
        uniq.push(ev);
      }
      setText("");
      setParsed(uniq);
      if (uniq.length === 0) {
        setStatus(readErr ? "일부 파일을 읽지 못했어요." : "읽은 파일에 일정이 없어요. (빈 캘린더이거나 해당 기간에 일정 없음)");
      } else {
        const dupNote = all.length > uniq.length ? ` (중복 ${all.length - uniq.length}개 제외)` : "";
        setStatus(`${files.length}개 파일에서 ${uniq.length}개 일정을 읽었어요${dupNote}. 공유 대상 확인 후 가져오기를 눌러 주세요.`);
      }
    };
    e.target.value = "";
  };

  const doImport = async () => {
    if (!parsed || parsed.length === 0 || !ownerId) return;
    if (v.visibility === "shared" && (v.sharedWith || []).length === 0) { setStatus("공유할 직원을 선택하세요."); return; }
    if (v.visibility === "team" && !(v.team || myTeam)) { setStatus("팀을 선택하세요."); return; }
    setBusy(true); setStatus("");
    try {
      const snapshot = resolveSharedWith(v, staff, myTeam); // 가져오는 시점 명단 고정
      let saved = 0;
      for (let i = 0; i < parsed.length; i += 400) {
        const chunk = parsed.slice(i, i + 400);
        const batch = writeBatch(db);
        chunk.forEach((ev) => {
          const ref = doc(collection(db, "office_schedules"));
          batch.set(ref, {
            ownerId,
            title: ev.title,
            date: ev.date,
            endDate: ev.endDate,
            allDay: ev.allDay,
            time: ev.time,
            location: ev.location,
            memo: ev.memo || "",
            color,
            repeat: ev.repeat || "none",
            visibility: v.visibility,
            team: v.visibility === "team" ? (v.team || myTeam) : "",
            sharedWith: snapshot,
            source: "naver",
            createdAt: Date.now(),
          });
          saved++;
        });
        await batch.commit();
      }
      setStatus(`${saved}개 일정을 가져왔어요. ✅`);
      setText(""); setParsed(null);
      if (onReload) onReload();
    } catch (e) {
      setStatus("저장 중 오류: " + (e && e.message ? e.message : "알 수 없음"));
    } finally {
      setBusy(false);
    }
  };

  const clearNaver = async () => {
    if (!ownerId) return;
    setBusy(true); setStatus("");
    try {
      const snap = await getDocs(collection(db, "office_schedules"));
      const targets = [];
      snap.forEach((d) => {
        const v = d.data();
        if (v.source === "naver" && v.ownerId === ownerId) targets.push(d.id);
      });
      for (let i = 0; i < targets.length; i += 400) {
        const batch = writeBatch(db);
        targets.slice(i, i + 400).forEach((id) => batch.delete(doc(db, "office_schedules", id)));
        await batch.commit();
      }
      setStatus(`가져온 네이버 일정 ${targets.length}개를 삭제했어요.`);
      setConfirmClear(false);
      if (onReload) onReload();
    } catch (e) {
      setStatus("삭제 중 오류: " + (e && e.message ? e.message : "알 수 없음"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="nv-import">
      <button className="nv-toggle" onClick={() => setOpen((o) => !o)}>
        네이버 일정 가져오기 {open ? "▴" : "▾"}
      </button>
      {open && (
        <div className="nv-box">
          <div className="nv-help">
            네이버 캘린더(PC 웹) → 설정 → 일정설정 → 캘린더별 <b>내보내기(백업)</b>로 받은 .ics 파일을
            아래에서 선택하면 자동으로 읽어요. (매주/매월/매년 반복 일정도 반영돼요)
          </div>
          <label className="nv-file">
            📁 .ics 파일 선택 (여러 개 가능)
            <input type="file" accept=".ics,text/calendar" multiple onChange={onFile} style={{ display: "none" }} />
          </label>
          <div className="nv-or">또는 아래에 내용 붙여넣기</div>
          <textarea
            className="nv-textarea"
            placeholder="여기에 .ics 내용을 붙여넣기"
            value={text}
            onChange={(e) => { setText(e.target.value); setParsed(null); setStatus(""); }}
          />
          <div className="nv-vis-label">이 파일의 공유 대상</div>
          <VisTypeSelect v={v} setV={setV} />
          <VisDetail v={v} setV={setV} staff={staff} myId={myId} myTeam={myTeam} />
          <div className="nv-vis-label">색상</div>
          <ColorPicker color={color} setColor={setColor} />
          <div className="nv-row">
            <button className="nv-btn" onClick={analyze} disabled={busy || !text.trim()}>분석</button>
            {parsed && parsed.length > 0 && (
              <button className="nv-btn primary" onClick={doImport} disabled={busy}>
                {busy ? "가져오는 중..." : `${parsed.length}개 가져오기`}
              </button>
            )}
          </div>
          {parsed && parsed.length > 0 && (
            <div className="nv-preview">
              {parsed.slice(0, 5).map((e, i) => (
                <div key={i} className="nv-pre-row">
                  <span className="nv-pre-date">{e.date}{e.time ? " " + e.time : ""}</span>
                  <span className="nv-pre-title">{e.title}</span>
                </div>
              ))}
              {parsed.length > 5 && <div className="nv-more">외 {parsed.length - 5}건…</div>}
            </div>
          )}
          {status && <div className="nv-status">{status}</div>}
          <div className="nv-danger-row">
            {!confirmClear ? (
              <button className="nv-danger" onClick={() => setConfirmClear(true)} disabled={busy}>
                가져온 네이버 일정 전체 삭제
              </button>
            ) : (
              <>
                <span className="nv-danger-q">정말 삭제할까요?</span>
                <button className="nv-danger confirm" onClick={clearNaver} disabled={busy}>삭제 확정</button>
                <button className="nv-btn" onClick={() => setConfirmClear(false)} disabled={busy}>취소</button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ===== 캘린더 탭 ===== */
function CalendarView({ eventsByDate, myId, myTeam, staff, schedulesById, colorRules, onReload, onDeleteSchedule, onUpdateSchedule, onSaveColorRules }) {
  const now = new Date();
  const [ym, setYm] = useState({ y: now.getFullYear(), m: now.getMonth() });
  const [sel, setSel] = useState(dateStr(now));
  const [showForm, setShowForm] = useState(false);
  const [editDoc, setEditDoc] = useState(null);
  const [delId, setDelId] = useState(null);
  const [expId, setExpId] = useState(null);

  const openAdd = () => { setEditDoc(null); setShowForm((s) => !s); };
  const openEdit = (id) => { const docv = schedulesById[id]; if (docv) { setEditDoc(docv); setShowForm(true); } };
  const closeForm = () => { setShowForm(false); setEditDoc(null); };

  const { y, m } = ym;
  const prevMonth = () => setYm((p) => (p.m === 0 ? { y: p.y - 1, m: 11 } : { y: p.y, m: p.m - 1 }));
  const nextMonth = () => setYm((p) => (p.m === 11 ? { y: p.y + 1, m: 0 } : { y: p.y, m: p.m + 1 }));
  const prevYear = () => setYm((p) => ({ y: p.y - 1, m: p.m }));
  const nextYear = () => setYm((p) => ({ y: p.y + 1, m: p.m }));
  const goToday = () => { const t = new Date(); setYm({ y: t.getFullYear(), m: t.getMonth() }); setSel(dateStr(t)); };

  const startWeekday = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const todayStr = dateStr(new Date());
  const selEvents = eventsByDate[sel] || [];
  const selHoliday = HOLIDAYS[sel];
  const selObj = sel ? new Date(sel + "T00:00:00") : null;
  const selLabel = selObj ? `${selObj.getMonth() + 1}월 ${selObj.getDate()}일 (${WEEKDAYS[selObj.getDay()]})` : "";

  return (
    <div className="cal-wrap">
      <div className="cal-nav">
        <button className="cal-nav-btn" onClick={prevYear} title="이전 해">«</button>
        <button className="cal-nav-btn" onClick={prevMonth} title="이전 달">‹</button>
        <span className="cal-title">{y}년 {m + 1}월</span>
        <button className="cal-nav-btn" onClick={nextMonth} title="다음 달">›</button>
        <button className="cal-nav-btn" onClick={nextYear} title="다음 해">»</button>
        <button className="cal-today-btn" onClick={goToday}>오늘</button>
      </div>

      <div className="cal-weekdays">
        {WEEKDAYS.map((w, i) => (
          <div key={w} className={"cal-wd" + (i === 0 ? " sun" : i === 6 ? " sat" : "")}>{w}</div>
        ))}
      </div>

      <div className="cal-grid">
        {cells.map((d, i) => {
          if (d === null) return <div className="cal-cell empty" key={i} />;
          const ds = `${y}-${pad2(m + 1)}-${pad2(d)}`;
          const wd = (startWeekday + d - 1) % 7;
          const evs = eventsByDate[ds] || [];
          const hol = HOLIDAYS[ds];
          const isToday = ds === todayStr;
          const isSel = ds === sel;
          const dayCls = "cal-day" + (hol || wd === 0 ? " holiday" : wd === 6 ? " sat" : "");
          const cellCls = "cal-cell" + (isSel ? " sel" : "") + (isToday ? " today" : "");
          return (
            <div className={cellCls} key={i} onClick={() => setSel(ds)}>
              <span className={dayCls}>{d}</span>
              {(() => { const lu = solarToLunar(ds); return lu ? <span className="cal-lu">{lu.day === 1 ? `${lu.leap ? "윤" : ""}${lu.month}.1` : lu.day}</span> : null; })()}
              {hol && <span className="cal-hol">{hol}</span>}
              {evs.length > 0 && (
                <div className="cal-chips">
                  {evs.slice(0, 6).map((e, j) => (
                    e.allDay ? (
                      <div key={j} className="ev-chip filled" style={{ background: e.color }}>{e.chip}</div>
                    ) : (
                      <div key={j} className="ev-chip">
                        <span className="ev-dot" style={{ background: e.color }} />
                        <span className="ev-chip-t">{e.chip}</span>
                      </div>
                    )
                  ))}
                  {evs.length > 6 && <div className="ev-more">+{evs.length - 6}</div>}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="cal-detail">
        <div className="cal-detail-head">
          <span className="cal-detail-date">{selLabel}</span>
          {selHoliday && <span className="cal-detail-hol">{selHoliday}</span>}
          <button className="cal-add-btn" onClick={openAdd}>{showForm && !editDoc ? "닫기" : "+ 일정"}</button>
        </div>
        {showForm && (
          <EventForm
            date={sel} myId={myId} staff={staff} myTeam={myTeam} editDoc={editDoc} colorRules={colorRules}
            onSaved={() => { closeForm(); if (onReload) onReload(); }}
            onCancel={closeForm}
          />
        )}
        {selEvents.length === 0 ? (
          <div className="empty">일정 없음</div>
        ) : (
          selEvents.map((e, i) => {
            if (e.type === "schedule") {
              const expanded = expId === e.scheduleId;
              return (
                <div className="cal-ev-item" key={i}>
                  <div className="cal-ev expandable"
                    onClick={() => setExpId(expanded ? null : e.scheduleId)}>
                    <span className="cal-ev-dot" style={{ background: e.color }} />
                    <span className="cal-ev-kind">일정{e.repeat && e.repeat !== "none" ? " 🔁" : ""}</span>
                    <span className="cal-ev-label">{e.chip}{e.ownerName ? " · " + e.ownerName : ""}</span>
                    <span className="cal-ev-chev">{expanded ? "▴" : "▾"}</span>
                    {e.canDelete && (
                      <span className="ev-actions">
                        <button className="ev-edit-x" onClick={(ev) => { ev.stopPropagation(); openEdit(e.scheduleId); }} title="수정">✎</button>
                        {delId === e.scheduleId ? (
                          <>
                            <button className="ev-del yes" onClick={(ev) => { ev.stopPropagation(); onDeleteSchedule(e.scheduleId); setDelId(null); }}>삭제</button>
                            <button className="ev-del no" onClick={(ev) => { ev.stopPropagation(); setDelId(null); }}>취소</button>
                          </>
                        ) : (
                          <button className="ev-del-x" onClick={(ev) => { ev.stopPropagation(); setDelId(e.scheduleId); }} title="삭제">✕</button>
                        )}
                      </span>
                    )}
                  </div>
                  {expanded && (
                    e.canDelete ? (
                      <MemoEditor scheduleId={e.scheduleId} initial={e.memo}
                        onSave={(m) => onUpdateSchedule(e.scheduleId, { memo: m })} />
                    ) : (
                      <div className="cal-ev-memo">{e.memo || "(비고 없음)"}</div>
                    )
                  )}
                </div>
              );
            }
            const kind = e.type === "deadline" ? "마감" : "수임";
            return (
              <div className="cal-ev clickable" key={i} onClick={() => openCase(e.caseId)} title="사무실앱에서 열기">
                <span className="cal-ev-dot" style={{ background: e.color }} />
                <span className="cal-ev-kind">{kind}</span>
                <span className="cal-ev-label">{e.label}{e.caseName ? " · " + e.caseName : ""}</span>
              </div>
            );
          })
        )}
      </div>

      <ColorSettings staff={staff} myId={myId} colorRules={colorRules} onSave={onSaveColorRules} />
      <NaverImport myId={myId} staff={staff} myTeam={myTeam} onReload={onReload} />
    </div>
  );
}

function fmtMsgTime(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/* ===== 쪽지 작성 ===== */
function Compose({ staff, myId, onSend }) {
  const [body, setBody] = useState("");
  const [toIds, setToIds] = useState([]);
  const [isTask, setIsTask] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const others = (staff || []).filter((s) => s.id !== myId);
  const nameOf = (id) => ((staff || []).find((s) => s.id === id)?.name) || id;
  const add = (id) => { if (id && !toIds.includes(id)) setToIds([...toIds, id]); };
  const remove = (id) => setToIds(toIds.filter((x) => x !== id));
  const send = async () => {
    if (!body.trim()) { setErr("내용을 입력하세요."); return; }
    if (toIds.length === 0) { setErr("받는 사람을 선택하세요."); return; }
    setBusy(true); setErr("");
    await onSend({ toIds, body: body.trim(), isTask });
    setBusy(false); setBody(""); setToIds([]); setIsTask(false);
  };
  return (
    <div className="msg-compose">
      <div className="af-color-label">받는 사람</div>
      <select className="vis-select" value="" onChange={(e) => { add(e.target.value); e.target.value = ""; }}>
        <option value="">직원 추가…</option>
        {others.filter((s) => !toIds.includes(s.id)).map((s) => (
          <option key={s.id} value={s.id}>{s.name || s.id}{s.team ? ` (${s.team})` : ""}</option>
        ))}
      </select>
      {toIds.length > 0 && (
        <div className="vis-members">
          {toIds.map((id) => (
            <span key={id} className="vis-chip">{nameOf(id)}<button className="vis-chip-x" onClick={() => remove(id)} title="제외">✕</button></span>
          ))}
        </div>
      )}
      <textarea className="msg-ta" placeholder="쪽지 내용" value={body} onChange={(e) => setBody(e.target.value)} />
      <label className="af-check">
        <input type="checkbox" checked={isTask} onChange={(e) => setIsTask(e.target.checked)} /> 업무 요청 (받는 사람이 완료 표시)
      </label>
      {err && <div className="af-err">{err}</div>}
      <button className="nv-btn primary" onClick={send} disabled={busy}>{busy ? "보내는 중..." : "보내기"}</button>
    </div>
  );
}

/* ===== 쪽지 탭 ===== */
function MessagesView({ myId, staff, messages, onSend, onMarkRead, onMarkDone, onDeleteMessage }) {
  const [view, setView] = useState("inbox");
  const [openId, setOpenId] = useState(null);
  const [delId, setDelId] = useState(null);
  const nameOf = (id) => ((staff || []).find((s) => s.id === id)?.name) || id;

  const inbox = (messages || []).filter((m) => Array.isArray(m.toIds) && m.toIds.includes(myId)).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const sent = (messages || []).filter((m) => m.fromId === myId).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  const openInbox = (m) => {
    const willOpen = openId !== m.id;
    setOpenId(willOpen ? m.id : null);
    if (willOpen && !(m.reads && m.reads[myId])) onMarkRead(m.id);
  };

  return (
    <div className="msg-wrap">
      <div className="msg-tabs">
        <button className={view === "inbox" ? "msg-tab on" : "msg-tab"} onClick={() => { setView("inbox"); setOpenId(null); }}>받은쪽지</button>
        <button className={view === "sent" ? "msg-tab on" : "msg-tab"} onClick={() => { setView("sent"); setOpenId(null); }}>보낸쪽지</button>
        <button className={view === "compose" ? "msg-tab on" : "msg-tab"} onClick={() => setView("compose")}>+ 작성</button>
      </div>

      {view === "compose" && (
        <Compose staff={staff} myId={myId} onSend={async (p) => { await onSend(p); setView("sent"); }} />
      )}

      {view === "inbox" && (
        inbox.length === 0 ? <div className="empty">받은 쪽지 없음</div> :
          inbox.map((m) => {
            const unread = !(m.reads && m.reads[myId]);
            const open = openId === m.id;
            const doneMine = m.done && m.done[myId];
            return (
              <div className="msg-item" key={m.id}>
                <div className="msg-head" onClick={() => openInbox(m)}>
                  {unread ? <span className="msg-unread" /> : <span className="msg-unread off" />}
                  <span className="msg-from">{nameOf(m.fromId)}</span>
                  {m.isTask && <span className="msg-badge task">업무</span>}
                  {m.isTask && doneMine && <span className="msg-badge done">완료</span>}
                  <span className="msg-preview">{m.body}</span>
                  <span className="msg-time">{fmtMsgTime(m.createdAt)}</span>
                </div>
                {open && (
                  <div className="msg-body">
                    <div className="msg-text">{m.body}</div>
                    {m.isTask && !doneMine && <button className="nv-btn primary" onClick={() => onMarkDone(m.id)}>업무 완료 처리</button>}
                    {m.isTask && doneMine && <span className="memo-saved">완료했어요 ✓ ({fmtMsgTime(doneMine)})</span>}
                  </div>
                )}
              </div>
            );
          })
      )}

      {view === "sent" && (
        sent.length === 0 ? <div className="empty">보낸 쪽지 없음</div> :
          sent.map((m) => {
            const open = openId === m.id;
            return (
              <div className="msg-item" key={m.id}>
                <div className="msg-head" onClick={() => setOpenId(open ? null : m.id)}>
                  <span className="msg-from">→ {(m.toIds || []).map(nameOf).join(", ")}</span>
                  {m.isTask && <span className="msg-badge task">업무</span>}
                  <span className="msg-preview">{m.body}</span>
                  <span className="msg-time">{fmtMsgTime(m.createdAt)}</span>
                </div>
                {open && (
                  <div className="msg-body">
                    <div className="msg-text">{m.body}</div>
                    <div className="msg-status">
                      {(m.toIds || []).map((tid) => {
                        const read = m.reads && m.reads[tid];
                        const done = m.done && m.done[tid];
                        return (
                          <div className="msg-stat-row" key={tid}>
                            <span className="msg-stat-name">{nameOf(tid)}</span>
                            <span className={read ? "msg-stat read" : "msg-stat"}>{read ? "읽음" : "안읽음"}</span>
                            {m.isTask && <span className={done ? "msg-stat done" : "msg-stat"}>{done ? "완료" : "진행중"}</span>}
                          </div>
                        );
                      })}
                    </div>
                    {delId === m.id ? (
                      <span className="ev-del-wrap">
                        <button className="ev-del yes" onClick={() => { onDeleteMessage(m.id); setDelId(null); }}>삭제</button>
                        <button className="ev-del no" onClick={() => setDelId(null)}>취소</button>
                      </span>
                    ) : (
                      <button className="msg-del" onClick={() => setDelId(m.id)}>쪽지 삭제</button>
                    )}
                  </div>
                )}
              </div>
            );
          })
      )}
    </div>
  );
}

/* ===== 내 사건 목록 컴포넌트 ===== */
function CaseRow({ c, isFav, onToggleFav, showOwner, ownerName }) {
  return (
    <div className="case-row">
      <button className="fav-btn" onClick={() => onToggleFav(c.id)} title="관심사건">{isFav ? "★" : "☆"}</button>
      <span className="case-name" onClick={() => openCase(c.id)} title="사무실앱에서 열기">{c.caseName || "(사건명 없음)"}</span>
      {showOwner && <span className="case-owner">{ownerName}</span>}
      <span className="case-sub">{c.clientName}</span>
    </div>
  );
}

function AlertLine({ label, count, special, scope }) {
  return (
    <div className="alert-line clickable" onClick={() => openFilter(special, scope)} title="사무실앱에서 열기">
      <span>{label}</span>
      <span className={count > 0 ? "cnt on" : "cnt"}>{count}</span>
    </div>
  );
}

function Panel({ title, sum, scope, favCases, onToggleFav, staffName, collapsible, teamName }) {
  const [collapsed, setCollapsed] = useState(!!collapsible);
  const [showAll, setShowAll] = useState(false);
  const favSet = new Set(favCases || []);
  const sortedInProgress = [...sum.inProgress].sort((a, b) => (favSet.has(a.id) ? 0 : 1) - (favSet.has(b.id) ? 0 : 1));
  const LIMIT = 8;
  const shown = showAll ? sortedInProgress : sortedInProgress.slice(0, LIMIT);
  const warnCount = sum.invoiceNeeded.length + sum.caseNoNeeded.length + sum.overdue.length + sum.deadlines.length;

  const body = (
    <>
      <div className="sec-label">진행중 ({sum.inProgress.length})</div>
      {sum.inProgress.length === 0 ? (
        <div className="empty">진행중 사건 없음</div>
      ) : (
        <>
          {shown.map((c) => (
            <CaseRow key={c.id} c={c} isFav={favSet.has(c.id)} onToggleFav={onToggleFav}
              showOwner={!!teamName} ownerName={teamName ? staffName(c.staffId) : ""} />
          ))}
          {sortedInProgress.length > LIMIT && (
            <button className="more-btn" onClick={() => setShowAll((s) => !s)}>
              {showAll ? "접기" : `더보기 (${sortedInProgress.length - LIMIT}개 더)`}
            </button>
          )}
        </>
      )}

      <div className="sec-label">확인 필요</div>
      <AlertLine label="계산서 발행 필요" count={sum.invoiceNeeded.length} special="invoiceNeeded" scope={scope} />
      <AlertLine label="사건번호 입력 필요" count={sum.caseNoNeeded.length} special="caseNoNeeded" scope={scope} />
      <AlertLine label="분할납 미납" count={sum.overdue.length} special="overdue" scope={scope} />

      <div className="sec-label">다가오는 마감</div>
      {sum.deadlines.length === 0 ? (
        <div className="empty">등록된 마감 없음</div>
      ) : (
        sum.deadlines.map((d, i) => {
          const over = d.date < today();
          return (
            <div className="dl-row" key={i}>
              <span className="dl-label">{d.label || "(제목없음)"} · {d.caseName}</span>
              <span className={over ? "dl-date over" : "dl-date"}>{d.date}{over ? " (지남)" : ""}</span>
            </div>
          );
        })
      )}
    </>
  );

  if (collapsible) {
    return (
      <div className="panel">
        <div className="panel-title collapsible" onClick={() => setCollapsed((c) => !c)}>
          <span>{title}</span>
          {collapsed && warnCount > 0 && <span className="panel-warn">⚠ 확인 {warnCount}</span>}
          <span className="panel-chev">{collapsed ? "▾" : "▴"}</span>
        </div>
        {!collapsed && body}
      </div>
    );
  }
  return (
    <div className="panel">
      {title && <div className="panel-title">{title}</div>}
      {body}
    </div>
  );
}

function App() {
  const [checking, setChecking] = useState(true);
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [staff, setStaff] = useState([]);        // office_staff
  const [cases, setCases] = useState([]);         // office_cases
  const [schedules, setSchedules] = useState([]); // office_schedules
  const [messages, setMessages] = useState([]);   // office_messages
  const [colorRules, setColorRules] = useState(null); // office_config/colorRules
  const [favCases, setFavCases] = useState([]);       // office_config/fav_<myId>
  const [loadingData, setLoadingData] = useState(false);

  const [tab, setTab] = useState("cases");
  const [opacity, setOpacity] = useState(1);
  const [showHeader, setShowHeader] = useState(true);

  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const bg = `rgba(28, 28, 30, ${opacity})`;

  const minimize = async () => { try { await appWindow.minimize(); } catch (e) {} };
  const close = async () => { try { await appWindow.close(); } catch (e) {} };

  useEffect(() => {
    setPersistence(auth, browserLocalPersistence).catch(() => {});
    const unsub = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      if (u) {
        try {
          const snap = await getDoc(doc(db, "office_users", u.uid));
          setProfile(snap.exists() ? { uid: u.uid, ...snap.data() } : null);
        } catch (e) { setProfile(null); }
      } else {
        setProfile(null);
      }
      setChecking(false);
    });
    return unsub;
  }, []);

  // 로그인되면 사건/직원/개인일정 데이터 로드
  const loadData = async () => {
    setLoadingData(true);
    try {
      const [cSnap, sSnap] = await Promise.all([
        getDocs(collection(db, "office_cases")),
        getDocs(collection(db, "office_staff")),
      ]);
      const cs = []; cSnap.forEach((d) => cs.push({ id: d.id, ...d.data() }));
      const ss = []; sSnap.forEach((d) => ss.push({ id: d.id, ...d.data() }));
      setCases(cs);
      setStaff(ss);
    } catch (e) {
      // 무시 (권한/네트워크)
    }
    // 개인일정은 컬렉션/규칙이 아직 없을 수 있어 별도 처리(사건 로딩을 막지 않도록)
    try {
      const schSnap = await getDocs(collection(db, "office_schedules"));
      const sch = []; schSnap.forEach((d) => sch.push({ id: d.id, ...d.data() }));
      setSchedules(sch);
    } catch (e) {
      setSchedules([]);
    }
    try {
      const mSnap = await getDocs(collection(db, "office_messages"));
      const ms = []; mSnap.forEach((d) => ms.push({ id: d.id, ...d.data() }));
      setMessages(ms);
    } catch (e) {
      setMessages([]);
    }
    const mid = profile?.legacyStaffId || user?.uid;
    try {
      const crSnap = await getDoc(doc(db, "office_config", "colorRules"));
      setColorRules(crSnap.exists() ? crSnap.data() : DEFAULT_COLOR_RULES);
    } catch (e) { setColorRules(DEFAULT_COLOR_RULES); }
    try {
      const fvSnap = await getDoc(doc(db, "office_config", "fav_" + mid));
      setFavCases(fvSnap.exists() ? (fvSnap.data().caseIds || []) : []);
    } catch (e) { setFavCases([]); }
    setLoadingData(false);
  };

  const loadMessages = async () => {
    try {
      const mSnap = await getDocs(collection(db, "office_messages"));
      const ms = []; mSnap.forEach((d) => ms.push({ id: d.id, ...d.data() }));
      setMessages(ms);
    } catch (e) {}
  };

  const sendMessage = async ({ toIds, body, isTask }) => {
    try {
      await addDoc(collection(db, "office_messages"), {
        fromId: myId,
        fromName: profile?.name || user?.email || "",
        toIds, body, isTask: !!isTask,
        createdAt: Date.now(), reads: {}, done: {},
      });
      await loadMessages();
    } catch (e) {}
  };
  const markRead = async (id) => { try { await updateDoc(doc(db, "office_messages", id), { ["reads." + myId]: Date.now() }); await loadMessages(); } catch (e) {} };
  const markDone = async (id) => { try { await updateDoc(doc(db, "office_messages", id), { ["done." + myId]: Date.now() }); await loadMessages(); } catch (e) {} };
  const deleteMessage = async (id) => { try { await deleteDoc(doc(db, "office_messages", id)); await loadMessages(); } catch (e) {} };

  const saveColorRules = async (rules) => {
    setColorRules(rules);
    try { await setDoc(doc(db, "office_config", "colorRules"), rules); } catch (e) {}
  };
  const toggleFav = async (caseId) => {
    const cur = favCases || [];
    const next = cur.includes(caseId) ? cur.filter((x) => x !== caseId) : [...cur, caseId];
    setFavCases(next);
    try { await setDoc(doc(db, "office_config", "fav_" + myId), { caseIds: next }); } catch (e) {}
  };

  const deleteSchedule = async (id) => {
    try { await deleteDoc(doc(db, "office_schedules", id)); await loadData(); } catch (e) {}
  };

  const updateScheduleFields = async (id, patch) => {
    try { await updateDoc(doc(db, "office_schedules", id), patch); await loadData(); } catch (e) {}
  };

  useEffect(() => {
    if (user && profile) loadData();
  }, [user, profile]);

  useEffect(() => {
    if (!user || !profile) return;
    const t = setInterval(() => { loadMessages(); }, 45000);
    return () => clearInterval(t);
  }, [user, profile]);

  // 현재 사용자 식별 (사무실앱과 동일: legacyStaffId 우선)
  const myId = profile?.legacyStaffId || user?.uid;
  const myRole = profile?.role || "member";
  const myTeam = profile?.team || "";
  const isLeader = myRole === "leader";

  // 팀원 id 목록 (팀장인 경우)
  const teamMemberIds = useMemo(() => {
    if (myRole !== "leader") return [];
    return (staff || [])
      .filter((s) => s.id !== myId && s.team === myTeam)
      .map((s) => s.id);
  }, [staff, myRole, myTeam, myId]);

  const staffName = (id) => (staff || []).find((s) => s.id === id)?.name || "";

  const unreadCount = useMemo(
    () => (messages || []).filter((m) => Array.isArray(m.toIds) && m.toIds.includes(myId) && !(m.reads && m.reads[myId])).length,
    [messages, myId]
  );

  // 내 담당 / 팀원 담당 사건
  const myCases = useMemo(() => (cases || []).filter((c) => c.staffId === myId), [cases, myId]);
  const teamCases = useMemo(
    () => (cases || []).filter((c) => teamMemberIds.includes(c.staffId)),
    [cases, teamMemberIds]
  );

  // 내가 볼 수 있는 일정 = 내가 만든 것 + 생성 당시 공유 명단에 내가 포함된 것
  // (실시간 팀원 계산이 아니라 명단 스냅샷이라, 나중에 입사한 사람에게 과거 일정이 소급 공개되지 않음)
  const visibleSchedules = useMemo(
    () => (schedules || []).filter((s) => {
      if (s.ownerId === myId) return true;
      return Array.isArray(s.sharedWith) && s.sharedWith.includes(myId);
    }),
    [schedules, myId]
  );

  const schedulesById = useMemo(() => {
    const m = {};
    (schedules || []).forEach((s) => { m[s.id] = s; });
    return m;
  }, [schedules]);

  // 캘린더용: 날짜별 일정 맵 (범위 = 내 사건 탭과 동일 + 내 개인일정)
  const eventsByDate = useMemo(() => {
    const map = {};
    const add = (date, ev) => { if (!date) return; (map[date] = map[date] || []).push(ev); };
    const scope = isLeader ? [...myCases, ...teamCases] : myCases;
    scope.forEach((c) => {
      (c.deadlines || []).forEach((d) => {
        if (d && d.date && !d.done) {
          add(String(d.date).slice(0, 10), {
            type: "deadline", allDay: true, color: DEADLINE_COLOR,
            chip: d.label || c.caseName || "마감",
            label: d.label || "마감", caseName: c.caseName, caseId: c.id,
          });
        }
      });
      const acc = caseAcceptDate(c);
      if (acc) add(acc, {
        type: "accept", allDay: true, color: ACCEPT_COLOR,
        chip: c.caseName || "수임",
        label: "수임", caseName: c.caseName, caseId: c.id,
      });
    });
    const nowY = new Date().getFullYear();
    const winStart = `${nowY - 2}-01-01`;
    const winEnd = `${nowY + 3}-12-31`;
    visibleSchedules.forEach((s) => {
      const vis = s.visibility || "private";
      const color = s.color || SCHED_COLORS[vis] || SCHED_COLORS.private;
      const chip = (s.allDay ? "" : (s.time ? s.time + " " : "")) + (s.title || "일정");
      const mine = s.ownerId === myId;
      const ownerName = mine ? "" : (staffName(s.ownerId) || "");
      const rep = s.repeat || "none";
      const evBase = {
        type: "schedule", allDay: !!s.allDay, color,
        chip, label: chip, title: s.title, scheduleId: s.id, visibility: vis,
        canDelete: mine, ownerName, memo: s.memo || "", repeat: rep,
      };
      // 반복 확장은 직접 만든 일정만. 네이버 일정은 실제 발생 날짜가 이미 파일에 있으므로 확장하지 않음
      if (rep !== "none" && s.source !== "naver") {
        expandRecurrences(s, winStart, winEnd).forEach((ds) => add(ds, evBase));
      } else {
        const start = s.date;
        if (!start) return;
        const end = s.endDate && s.endDate >= start ? s.endDate : start;
        let cur = start, guard = 0;
        while (cur <= end && guard < 120) { add(cur, evBase); cur = addDaysStr(cur, 1); guard++; }
      }
    });
    const ORD = { deadline: 0, accept: 1, schedule: 2 };
    Object.keys(map).forEach((k) => {
      map[k].sort((a, b) => ((ORD[a.type] == null ? 9 : ORD[a.type]) - (ORD[b.type] == null ? 9 : ORD[b.type])));
    });
    return map;
  }, [myCases, teamCases, isLeader, visibleSchedules, myId, staff]);

  // 특정 사건집합의 요약 계산
  const summarize = (list) => {
    const inProgress = list.filter((c) => c.status === "진행중");
    const invoiceNeeded = list.filter((c) => c.settled && !c.invoiceIssued);
    const caseNoNeeded = list.filter(
      (c) => CASE_NO_MAJORS.includes(c.majorCategory) && !(c.courtCaseNo || "").trim()
    );
    const overdue = list.filter((c) => isOverdueCase(c));
    const deadlines = list
      .flatMap((c) =>
        (c.deadlines || [])
          .filter((d) => !d.done && d.date)
          .map((d) => ({ ...d, caseName: c.caseName }))
      )
      .sort((a, b) => (a.date || "").localeCompare(b.date || ""))
      .slice(0, 8);
    return { inProgress, invoiceNeeded, caseNoNeeded, overdue, deadlines };
  };

  const login = async () => {
    setErr("");
    if (!email.trim() || !pw) { setErr("이메일과 비밀번호를 입력하세요."); return; }
    setBusy(true);
    try {
      await signInWithEmailAndPassword(auth, email.trim(), pw);
      setPw("");
    } catch (e) {
      const msg = e.code === "auth/invalid-credential" ? "이메일 또는 비밀번호가 올바르지 않습니다."
        : e.code === "auth/invalid-email" ? "이메일 형식이 올바르지 않습니다."
        : e.message || "로그인 실패";
      setErr(msg);
    } finally {
      setBusy(false);
    }
  };
  const logout = async () => { try { await signOut(auth); } catch (e) {} };

  const DragBar = ({ children }) => (
    <div className="drag-bar" data-tauri-drag-region>{children}</div>
  );

  if (checking) {
    return (
      <div className="widget" style={{ background: bg }}>
        <DragBar>
          <div style={{ flex: 1 }} />
          <button className="win-btn" onClick={minimize} title="최소화">﹣</button>
          <button className="win-btn close" onClick={close} title="닫기">✕</button>
        </DragBar>
        <div className="center-msg">불러오는 중...</div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="widget" style={{ background: bg }}>
        <DragBar>
          <span className="drag-title">참괜찮은 사무실 위젯</span>
          <div style={{ flex: 1 }} />
          <button className="win-btn" onClick={minimize} title="최소화">﹣</button>
          <button className="win-btn close" onClick={close} title="닫기">✕</button>
        </DragBar>
        <div className="login-box">
          <div className="login-title">로그인</div>
          <input className="input" type="email" placeholder="이메일" value={email}
            onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
          <input className="input" type="password" placeholder="비밀번호" value={pw}
            onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") login(); }} autoComplete="current-password" />
          {err && <div className="login-err">{err}</div>}
          <button className="login-btn" onClick={login} disabled={busy}>
            {busy ? "로그인 중..." : "로그인"}
          </button>
          <div className="login-hint">한 번 로그인하면 유지됩니다.</div>
        </div>
      </div>
    );
  }

  const displayName = profile?.name || user.email;
  const mySum = summarize(myCases);
  const teamSum = isLeader ? summarize(teamCases) : null;

  return (
    <div className="widget" style={{ background: bg }}>
      {showHeader ? (
        <div className="widget-header" data-tauri-drag-region>
          <div className="tabs">
            <button className={tab === "cases" ? "tab active" : "tab"} onClick={() => setTab("cases")}>내 사건</button>
            <button className={tab === "calendar" ? "tab active" : "tab"} onClick={() => setTab("calendar")}>캘린더</button>
            <button className={tab === "messages" ? "tab active" : "tab"} onClick={() => setTab("messages")}>
              쪽지{unreadCount > 0 ? <span className="tab-badge">{unreadCount}</span> : null}
            </button>
          </div>
          <div className="header-right">
            <input className="opacity-slider" type="range" min="0.2" max="1" step="0.05"
              value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} title="배경 투명도" />
            <button className="win-btn" onClick={() => setShowHeader(false)} title="헤더 숨기기">▴</button>
            <button className="win-btn" onClick={minimize} title="최소화">﹣</button>
            <button className="win-btn close" onClick={close} title="닫기">✕</button>
          </div>
        </div>
      ) : (
        <div className="widget-handle" data-tauri-drag-region>
          <button className="win-btn" onClick={() => setShowHeader(true)} title="헤더 보이기">▾</button>
        </div>
      )}

      {showHeader && (
        <div className="user-bar">
          <span className="user-name">{displayName}{isLeader ? ` · ${myTeam} 팀장` : ""}</span>
          <div>
            <button className="logout-btn" onClick={loadData} title="새로고침">↻</button>
            <button className="logout-btn" onClick={logout}>로그아웃</button>
          </div>
        </div>
      )}

      <div className="widget-body">
        {tab === "cases" && (
          loadingData ? (
            <div className="empty" style={{ marginTop: 30 }}>사건 불러오는 중...</div>
          ) : (
            <>
              <Panel title={isLeader ? "내 담당" : null} sum={mySum} scope={isLeader ? "own" : ""}
                favCases={favCases} onToggleFav={toggleFav} staffName={staffName} />
              {isLeader && teamSum && (
                <Panel title={`팀원 담당 (${myTeam})`} sum={teamSum} scope="team"
                  favCases={favCases} onToggleFav={toggleFav} staffName={staffName}
                  collapsible teamName={myTeam} />
              )}
            </>
          )
        )}
        {tab === "calendar" && (
          loadingData ? (
            <div className="empty" style={{ marginTop: 30 }}>사건 불러오는 중...</div>
          ) : (
            <CalendarView
              eventsByDate={eventsByDate}
              myId={myId}
              myTeam={myTeam}
              staff={staff}
              schedulesById={schedulesById}
              colorRules={colorRules}
              onReload={loadData}
              onDeleteSchedule={deleteSchedule}
              onUpdateSchedule={updateScheduleFields}
              onSaveColorRules={saveColorRules}
            />
          )
        )}
        {tab === "messages" && (
          <MessagesView
            myId={myId}
            staff={staff}
            messages={messages}
            onSend={sendMessage}
            onMarkRead={markRead}
            onMarkDone={markDone}
            onDeleteMessage={deleteMessage}
          />
        )}
      </div>
    </div>
  );
}

export default App;
