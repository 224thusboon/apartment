# ระบบจัดการหอพัก 20 ห้อง

| ส่วน | ใช้ทำอะไร | อยู่ที่ |
|---|---|---|
| Google Apps Script | หลังบ้าน + หน้าจอทั้งหมด | `gas/` |
| Firestore | ฐานข้อมูล | Google Cloud |
| Google Drive | สลิป, รูปซ่อม, PDF ใบแจ้งหนี้/สัญญา | สร้างอัตโนมัติด้วย `setup()` |
| Google Docs | แม่แบบใบแจ้งหนี้ / สัญญาเช่า | สร้างอัตโนมัติด้วย `setup()` |
| GitHub Pages | หน้าห่อให้ติดตั้งเป็นแอป (PWA) | `docs/` |

## ฟีเจอร์

**ผู้ดูแล** — ผังห้อง 20 ห้อง · ย้ายเข้า/ย้ายออก (เก็บประวัติทุกครั้ง) · ออก PIN ให้ผู้เช่า ·
จดมิเตอร์น้ำ/ไฟ → ออกใบแจ้งหนี้ PDF ทุกห้องในคลิกเดียว · ตรวจสลิป อนุมัติ/ไม่ผ่าน ·
บันทึกงานซ่อม/อะไหล่ + รูป · สร้างสัญญาเช่าจากแม่แบบ · ตั้งค่าเรทน้ำไฟ ค่าส่วนกลาง สี ชื่อหอ

**ผู้เช่า** — เข้าด้วยเลขห้อง + PIN · ดูบิล/PDF · แนบสลิป · แจ้งซ่อมพร้อมรูป · ดูสัญญาเช่า

## ขั้นตอนติดตั้ง

### 1. Google Cloud + Firestore
1. ไปที่ https://console.cloud.google.com สร้างโปรเจกต์ใหม่ (เช่น `dorm-app`)
2. เมนู **Firestore** → **Create database** → โหมด **Native** → location `asia-southeast1` (สิงคโปร์)
3. จด **Project ID** และ **Project number** (หน้า Dashboard)
4. **APIs & Services → OAuth consent screen** → ตั้งค่าแบบ External, ใส่ชื่อแอปและอีเมล (ไม่ต้อง publish)

### 2. Apps Script
1. ไปที่ https://script.google.com → **New project**
2. สร้างไฟล์ตามโฟลเดอร์ `gas/` ทุกไฟล์ (ชื่อเดียวกัน, `.gs` = Script, `.html` = HTML)
3. **Project Settings** → ติ๊ก *Show "appsscript.json"* แล้ววางเนื้อหาจาก `gas/appsscript.json`
4. **Project Settings → Google Cloud Platform (GCP) Project → Change project** → ใส่ Project number จากข้อ 1
5. **Project Settings → Script properties** เพิ่ม
   - `FIRESTORE_PROJECT_ID` = Project ID
   - `SHELL_ORIGIN` = `https://<ชื่อผู้ใช้ GitHub>.github.io`
   - `ADMIN_PASSWORD` = รหัสผ่านผู้ดูแล (ถ้าไม่ใส่ `setup()` จะสุ่มให้และแสดงใน Logs)
6. เลือกฟังก์ชัน `setup` → **Run** → อนุญาตสิทธิ์ → ดู Logs (สร้างโฟลเดอร์ Drive, แม่แบบ, ห้อง 101–110, 201–210)
7. **Deploy → New deployment → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
   - คัดลอก URL ที่ลงท้าย `/exec`

> ทางเลือก: ใช้ [clasp](https://github.com/google/clasp) `clasp push` จากโฟลเดอร์ `gas/` แทนการคัดลอกทีละไฟล์

### 3. GitHub Pages (ให้ติดตั้งเป็นแอปได้)
1. แก้ `docs/config.js` ใส่ `GAS_URL`, ชื่อหอ, สี
2. แก้ชื่อ/สีใน `docs/manifest.webmanifest` ให้ตรงกัน
3. push ขึ้น GitHub → **Settings → Pages** → Source: `main` / folder `/docs`
4. ส่งลิงก์ `https://<user>.github.io/<repo>/` ให้ผู้เช่า

ผู้เช่าเปิดลิงก์แล้วจะเจอหน้าบังคับติดตั้ง:
- **Android (Chrome)** มีปุ่ม "ติดตั้งลงเครื่อง"
- **iPhone (Safari)** มีวิธีกด แชร์ → เพิ่มไปยังหน้าจอโฮม
- เปิดจาก **LINE** จะเด้งไปเบราว์เซอร์ให้อัตโนมัติ
- **คอมพิวเตอร์** (ผู้ดูแล) เข้าใช้ได้ทันที

## แก้แม่แบบเอกสาร
หน้า **ตั้งค่า** มีลิงก์ไปยังแม่แบบใน Google Docs แก้ข้อความ ฟอนต์ โลโก้ได้อิสระ
แต่ต้องคงตัวแทนไว้:

- ใบแจ้งหนี้: `{{dormName}} {{dormAddress}} {{phone}} {{month}} {{roomId}} {{tenantName}} {{issuedAt}} {{dueDate}} {{ITEMS}} {{total}} {{bankInfo}}`
  (`{{ITEMS}}` ต้องอยู่บรรทัดของตัวเอง จะถูกแทนด้วยตารางรายการ)
- สัญญาเช่า: `{{dormName}} {{dormAddress}} {{ownerName}} {{contractDate}} {{tenantName}} {{tenantIdCard}} {{tenantAddress}} {{tenantPhone}} {{roomId}} {{moveIn}} {{rent}} {{deposit}} {{dueDay}}`

## วิธีคิดค่าน้ำ/ไฟ
หน่วยที่ใช้ = เลขมิเตอร์สิ้นเดือนนี้ − เลขมิเตอร์สิ้นเดือนก่อน (เดือนแรกใช้เลขตอนย้ายเข้า)
ค่าน้ำ = max(หน่วย × เรท, ขั้นต่ำ) · ค่าไฟเหมือนกัน · บวกค่าเช่า + ค่าใช้จ่ายอื่นในหน้าตั้งค่า

## โครงสร้างข้อมูล (Firestore)
| collection | เนื้อหา |
|---|---|
| `settings/main` | ชื่อหอ เรทน้ำไฟ ฯลฯ |
| `rooms/{เลขห้อง}` | ค่าเช่า สถานะ ผู้เช่าปัจจุบัน |
| `tenants` | ชื่อ เบอร์ บัตรประชาชน ที่อยู่ |
| `tenancies` | การเข้าพักแต่ละครั้ง (วันเข้า/ออก มิเตอร์ตอนเข้า PIN สัญญา) |
| `readings/{ห้อง}_{YYYY-MM}` | เลขมิเตอร์สิ้นเดือน |
| `invoices/{ห้อง}_{YYYY-MM}` | ใบแจ้งหนี้ |
| `payments` | สลิปที่ผู้เช่าส่ง |
| `repairs` | ประวัติซ่อม/อะไหล่ |
| `sessions` | การเข้าสู่ระบบ |

## ค่าที่ยังเป็นค่าสมมติ (แก้ในหน้าตั้งค่า)
ชื่อหอ · ที่อยู่ · เรทน้ำ 18 ฿/หน่วย ขั้นต่ำ 100 · เรทไฟ 8 ฿/หน่วย · ค่าเช่าห้องละ 3,000 ·
ข้อความสัญญาเช่า (แทนที่ด้วยสัญญาจริงในแม่แบบ)
