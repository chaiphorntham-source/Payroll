#!/usr/bin/env node
/**
 * ตรวจ doPost ฝั่งบอท LINE บน Node (จำลอง Apps Script — ไม่ยิงเน็ต ไม่แตะ Google จริง)
 * ใช้: node tests/test-bot-endpoint.js [path/to/Code.gs]
 * ครอบคลุม: รหัสลับทุกเส้น · timesheet_image (ตรวจรูป/รหัสพนักงาน/รหัสฟอร์ม/แถวอ่านไม่ออก/AI ล้ม) · ผูก LINE id กับพนักงานเฉพาะแถวที่ HR ตรวจแล้ว
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const file = process.argv[2] || path.join(__dirname, '..', 'Code.gs');
const SECRET = 'a'.repeat(64);
const UID = 'U' + '0123456789abcdef'.repeat(2);
const JPEG = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3, 4]).toString('base64');
const PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 1, 2, 3, 4]).toString('base64');

function load(opt = {}) {
  const props = { ...(opt.props || { BOT_SECRET: SECRET }) };
  const sheets = { Attendance: [], Import_Log: [] };
  const files = [];
  const ocrCalls = [];
  const ctx = {
    console: { log() {}, warn() {}, error() {} }, Object, JSON, Math, String, Date, Array, parseInt, parseFloat, isNaN, Number, RegExp,
    Utilities: {
      base64Decode: (s) => { if (/[^A-Za-z0-9+/=]/.test(s)) throw new Error('bad b64'); return Array.from(Buffer.from(s, 'base64')).map((b) => (b > 127 ? b - 256 : b)); },
      base64Encode: (b) => Buffer.from(b).toString('base64'),
      formatDate: (d, tz, f) => (f === 'yyyy-MM-dd' ? '2026-10-08' : '20261008_120000'),
      newBlob: (bytes, mime, name) => ({ bytes, mime, name }),
      getUuid: () => 'uuid',
    },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (t) => ({ setMimeType: () => ({ body: t }) }) },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(file, 'utf8'), ctx);
  const sheet = (name) => ({ appendRow: (r) => sheets[name].push(r) });
  ctx.props_ = () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; } });
  ctx.getSs_ = () => ({ getSheetByName: sheet });
  ctx.subFolder_ = (n) => ({ createFile: (blob) => { const f = { folder: n, name: blob.name, getUrl: () => 'https://drive/' + blob.name, getId: () => 'id-' + blob.name }; files.push(f); return f; } });
  ctx.readSheet_ = (n) => (n === 'Employees' ? [{ employee_id: 'EMP001', employee_name: 'สมชาย ตัวอย่าง' }, { employee_id: 'EMP002', employee_name: 'สมหญิง ตัวอย่าง' }] : (opt.sheetRows || {})[n] || []);
  ctx.ocrTimesheetImage_ = (b64, mime, o) => { ocrCalls.push({ b64, mime, o, filesBefore: files.length }); return typeof opt.ocr === 'function' ? opt.ocr() : opt.ocr; };
  const post = (body) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).body);
  return { ctx, post, sheets, files, ocrCalls, props };
}

const goodOcr = (over = {}) => ({
  ok: true, model: 'm', warnings: [],
  header: { name: 'สมชาย ตัวอย่าง', employee_id: 'EMP001', period_from: '2026-09-01', period_to: '2026-09-15', form_code: 'PAY-TS · ใบที่ 1/1', ...(over.header || {}) },
  rows: over.rows || [
    { work_date: '2026-09-01', check_in: '09:00', check_out: '18:00' },
    { work_date: '2026-09-02', check_in: '9:05', check_out: '18:30' },
  ],
});

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => { cond ? pass++ : fail++; console.log((cond ? '  ok   ' : '  FAIL ') + label + (cond ? '' : '  → ' + extra)); };
const ts = (over = {}) => ({ action: 'timesheet_image', secret: SECRET, lineUserId: UID, displayName: 'สมชาย', image: JPEG, contentType: 'image/jpeg', ...over });

console.log('รหัสลับ');
{
  const t = load({ ocr: goodOcr() });
  check('เส้นเดิม (rows) ไม่มี secret → unauthorized ไม่เขียนชีต', t.post({ lineUserId: UID, rows: [{ employee_id: 'EMP001', work_date: '2026-09-01', check_in: '09:00', check_out: '18:00' }] }).reason === 'unauthorized' && t.sheets.Attendance.length === 0);
  check('timesheet_image secret ผิด → unauthorized ไม่เรียก AI', t.post(ts({ secret: 'b'.repeat(64) })).reason === 'unauthorized' && t.ocrCalls.length === 0);
  check('payslip_list ไม่มี secret → unauthorized', t.post({ action: 'payslip_list', lineUserId: UID }).reason === 'unauthorized');
  const r = t.post({ secret: SECRET, lineUserId: UID, rows: [{ employee_id: 'EMP001', work_date: '2026-09-01', check_in: '09:00', check_out: '18:00' }] });
  check('เส้นเดิม (rows) secret ถูก → บันทึก 1 แถว', r.ok && t.sheets.Attendance.length === 1, JSON.stringify(r));
  const n = load({ props: {}, ocr: goodOcr() });
  check('ยังไม่ตั้ง BOT_SECRET → ปฏิเสธทุกคำขอ (แม้ส่ง secret ว่าง)', n.post(ts({ secret: '' })).reason === 'unauthorized' && n.ocrCalls.length === 0);
}

console.log('timesheet_image');
{
  const t = load({ ocr: goodOcr() });
  const r = t.post(ts());
  check('อ่านได้ → ok + count 2', r.ok && r.count === 2, JSON.stringify(r));
  check('แถวในชีต = รอตรวจสอบ + LINE id + รหัสจากหัวใบ', t.sheets.Attendance.every((a) => a[12] === 'รอตรวจสอบ' && a[2] === UID && a[4] === 'EMP001'), JSON.stringify(t.sheets.Attendance[0]));
  check('เวลา "9:05" → "09:05"', t.sheets.Attendance[1][7] === '09:05', t.sheets.Attendance[1][7]);
  check('ไม่รับ พัก/ชม.ปกติ/OT จาก AI (0 = ให้ calcRowHours_ คิดเอง เหมือนเส้นหน้าเว็บ)', t.sheets.Attendance.every((a) => a[9] === 0 && a[10] === 0 && a[11] === 0), JSON.stringify(t.sheets.Attendance[0].slice(9, 12)));
  check('เก็บรูปลง 01_Inbox ก่อนเรียก AI', t.ocrCalls[0].filesBefore === 1 && t.files[0].folder === '01_Inbox' && /^LINE_.*\.jpg$/.test(t.files[0].name), JSON.stringify(t.files.map((f) => f.name)));
  check('Import_Log = สำเร็จ', t.sheets.Import_Log.length === 1 && t.sheets.Import_Log[0][4] === 'สำเร็จ');
  check('คืนชื่อพนักงานจากทะเบียน', r.employee_name === 'สมชาย ตัวอย่าง' && r.employee_id === 'EMP001');

  const p = load({ ocr: goodOcr() }); p.post(ts({ image: PNG }));
  check('PNG → ส่ง AI เป็น image/png', p.ocrCalls[0].mime === 'image/png');

  const bad = load({ ocr: goodOcr() });
  const rb = bad.post(ts({ image: Buffer.from('%PDF-1.4 hello').toString('base64') }));
  check('ไม่ใช่ JPG/PNG (magic bytes) → bad_image ไม่เก็บไฟล์ ไม่เรียก AI', rb.reason === 'bad_image' && bad.files.length === 0 && bad.ocrCalls.length === 0, JSON.stringify(rb));

  const u = load({ ocr: goodOcr() });
  check('LINE id รูปแบบผิด → bad_user', u.post(ts({ lineUserId: 'EMP001' })).reason === 'bad_user' && u.ocrCalls.length === 0);

  const e = load({ ocr: goodOcr({ header: { employee_id: 'EMP999' } }) });
  const re = e.post(ts());
  check('รหัสพนักงานไม่อยู่ในทะเบียน → unknown_employee ไม่เขียน Attendance + log ผิดพลาด', re.reason === 'unknown_employee' && e.sheets.Attendance.length === 0 && e.sheets.Import_Log[0][4] === 'ผิดพลาด', JSON.stringify(re));
  check('ไม่รับ employee_id ที่บอทส่งมาเอง', (() => { const x = load({ ocr: goodOcr({ header: { employee_id: 'EMP999' } }) }); return x.post(ts({ employee_id: 'EMP001', rows: [{ employee_id: 'EMP001' }] })).reason === 'unknown_employee' && x.sheets.Attendance.length === 0; })());

  const f = load({ ocr: goodOcr({ header: { form_code: 'HR-TS-02' } }) });
  check('รหัสฟอร์มอ่านได้แต่ไม่ใช่ PAY-TS → wrong_form', f.post(ts()).reason === 'wrong_form' && f.sheets.Attendance.length === 0);
  const fb = load({ ocr: goodOcr({ header: { form_code: '' } }) });
  check('รหัสฟอร์มอ่านไม่ออก → ปล่อยผ่าน (is_timesheet กรองแล้ว)', fb.post(ts()).ok === true);

  const s = load({ ocr: goodOcr({ rows: [
    { work_date: '2026-09-01', check_in: '09:00', check_out: '18:00' },
    { work_date: '', check_in: '09:00', check_out: '18:00', unreadable: true },
    { work_date: '2026-09-03', check_in: '25:99', check_out: '18:00', unreadable: true },
  ] }) });
  const rs = s.post(ts());
  check('แถวอ่านไม่ออกไม่บันทึก → count 1 skipped 2', rs.ok && rs.count === 1 && rs.skipped === 2 && s.sheets.Attendance.length === 1, JSON.stringify(rs));

  const z = load({ ocr: goodOcr({ rows: [{ work_date: '', check_in: '', check_out: '', unreadable: true }] }) });
  check('ไม่มีแถวที่อ่านได้เลย → no_rows', z.post(ts()).reason === 'no_rows' && z.sheets.Attendance.length === 0);

  const o = load({ ocr: { ok: false, error: 'รูปนี้ไม่ใช่ใบลงเวลา (ดูเหมือน ใบเสร็จ)' } });
  const ro = o.post(ts());
  check('AI ล้ม/ไม่ใช่ใบลงเวลา → ocr_failed + ข้อความเดิม + รูปยังอยู่ใน Inbox', ro.reason === 'ocr_failed' && /ไม่ใช่ใบลงเวลา/.test(ro.error) && o.files.some((x) => /\.jpg$/.test(x.name)), JSON.stringify(ro));
  const ox = load({ ocr: () => { throw new Error('boom'); } });
  check('AI โยน exception → ocr_failed ไม่ล่ม', ox.post(ts()).reason === 'ocr_failed');

  const tt = load({ ocr: goodOcr() }); tt.post(ts({ lineUserId: 'TEST_BOT_abcd1234' }));
  check('LINE id ทดสอบ → ไฟล์ขึ้นต้น TEST_BOT_ (apiPurgeBotTest ลบได้)', tt.files.every((x) => /^TEST_BOT_/.test(x.name)), JSON.stringify(tt.files.map((x) => x.name)));
}

console.log('ผูก LINE id → พนักงาน (ขอสลิป)');
{
  const att = (status, id) => ({ line_user_id: UID, employee_id: id, employee_name: '', status });
  const only = load({ sheetRows: { Attendance: [att('รอตรวจสอบ', 'EMP002')] } });
  check('มีแค่แถวรอตรวจสอบ → ยังไม่ผูก (null)', only.ctx.payslipEmployeeOf_(UID) === null);
  const ok = load({ sheetRows: { Attendance: [att('อนุมัติแล้ว', 'EMP001'), att('รอตรวจสอบ', 'EMP002')] } });
  const w = ok.ctx.payslipEmployeeOf_(UID);
  check('ข้ามแถวรอตรวจสอบล่าสุด → ใช้แถวที่อนุมัติแล้ว (EMP001)', w && w.employee_id === 'EMP001', JSON.stringify(w));
  const v = load({ sheetRows: { Attendance: [att('อนุมัติแล้ว', 'EMP001'), att('ตรวจสอบแล้ว', 'EMP002')] } });
  check('ตรวจสอบแล้ว ล่าสุด → EMP002', v.ctx.payslipEmployeeOf_(UID).employee_id === 'EMP002');
}

console.log(`\nRUN ${pass + fail} · PASS ${pass} · FAIL ${fail}`);
process.exitCode = fail ? 1 : 0;
