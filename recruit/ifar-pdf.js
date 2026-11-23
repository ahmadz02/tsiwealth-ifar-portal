// Builds the IFAR Application Form PDF (A4) in the layout of 2023-AD-TSIWP-FORM-0001-01,
// followed by compressed appendix pages (uploaded documents) and an audit-trail page.
// Requires: jsPDF (window.jspdf), ifar-logo.js, ifar-shared.js. pdf.js (window.pdfjsLib) only if a PDF was uploaded.

const IFAR_FORM_CODE = '2023-AD-TSIWP-FORM-0001-01';
const IFAR_IMG_MAX_SIDE = 1600;   // px, longest side of every embedded scan
const IFAR_IMG_QUALITY = 0.68;    // JPEG quality
const IFAR_PDF_MAX_PAGES = 10;    // max pages rasterised from one uploaded PDF

async function ifarDefaultLoadFile(path) {
  const { data, error } = await supabaseClient.storage.from(IFAR_BUCKET).download(path);
  if (error) throw new Error('Unable to download ' + path + ': ' + error.message);
  return data;
}

function ifarCanvasToJpeg(canvas) {
  return { dataUrl: canvas.toDataURL('image/jpeg', IFAR_IMG_QUALITY), w: canvas.width, h: canvas.height };
}

// Returns an array of {dataUrl,w,h}: one entry for an image, one per page for a PDF.
async function ifarDefaultPrepareFile(blob, meta) {
  const isPdf = (meta.type || blob.type) === 'application/pdf' || /\.pdf$/i.test(meta.name || '');
  if (!isPdf) {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, IFAR_IMG_MAX_SIDE / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    return [ifarCanvasToJpeg(c)];
  }
  if (!window.pdfjsLib) throw new Error('PDF reader (pdf.js) is not loaded.');
  const doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
  const out = [];
  const n = Math.min(doc.numPages, IFAR_PDF_MAX_PAGES);
  for (let p = 1; p <= n; p++) {
    const page = await doc.getPage(p);
    const base = page.getViewport({ scale: 1 });
    const scale = IFAR_IMG_MAX_SIDE / Math.max(base.width, base.height);
    const vp = page.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    out.push(ifarCanvasToJpeg(c));
  }
  if (doc.numPages > n) out.truncated = doc.numPages - n;
  return out;
}

/**
 * @param app  row from ifar_applications (form_data, files, applicant_signature, official_use, ...)
 * @param opts { auditEvents, loadFile(path)->Blob, prepareFile(blob,meta)->[{dataUrl,w,h}], jsPDF }
 * @returns {pdf, blob, filename}
 */
async function buildIfarApplicationPDF(app, opts = {}) {
  const JsPDF = opts.jsPDF || window.jspdf.jsPDF;
  const loadFile = opts.loadFile || ifarDefaultLoadFile;
  const prepareFile = opts.prepareFile || ifarDefaultPrepareFile;
  const fd = app.form_data || {};
  const files = app.files || {};
  const official = app.official_use || {};
  const pr = fd.principals || {};
  const nok = fd.nok || {};
  const bank = fd.bank || {};

  const pdf = new JsPDF({ unit: 'pt', format: 'a4' });
  const PW = pdf.internal.pageSize.getWidth();
  const PH = pdf.internal.pageSize.getHeight();
  const M = 36, CW = PW - 2 * M;
  const BAR = [189, 206, 230];
  let y = 0;

  const clean = s => String(s ?? '').replace(/[\u2013\u2014]/g, '-').replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/[^\x09\x0A\x0D\x20-\x7E -ÿ]/g, '?');
  const fmtD = v => { if (!v) return ''; const d = new Date(v); return isNaN(d) ? '' : d.toLocaleDateString('en-GB'); };
  const fmtDT = v => { if (!v) return '-'; const d = new Date(v); return isNaN(d) ? '-' : d.toLocaleString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); };

  function newPage(first) {
    if (!first) pdf.addPage();
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(7.5); pdf.setTextColor(60);
    pdf.text(IFAR_FORM_CODE, PW - M, 20, { align: 'right' });
    pdf.setTextColor(0);
    y = 34;
  }
  function ensure(h) { if (y + h > PH - 36) newPage(); }
  function box(x, yy, w, h) { pdf.setDrawColor(0); pdf.setLineWidth(0.6); pdf.rect(x, yy, w, h); }
  function bar(title, note) {
    ensure(18);
    pdf.setFillColor(...BAR); pdf.setDrawColor(0); pdf.setLineWidth(0.6);
    pdf.rect(M, y, CW, 16, 'FD');
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(9.5); pdf.text(title, M + 6, y + 11.5);
    if (note) {
      const tw = pdf.getTextWidth(title);
      pdf.setFont('helvetica', 'italic'); pdf.setFontSize(8); pdf.text(note, M + 10 + tw, y + 11.5);
    }
    y += 16;
  }
  function label(x, yy, text) { pdf.setFont('helvetica', 'normal'); pdf.setFontSize(7); pdf.setTextColor(70); pdf.text(clean(text), x, yy); pdf.setTextColor(0); }
  function value(x, yy, w, h, text, size = 9.5) {
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(size);
    const lh = size + 1.5;
    const lines = pdf.splitTextToSize(clean(text), w);
    const max = Math.max(1, Math.floor(h / lh));
    pdf.text(lines.slice(0, max), x, yy);
  }
  function field(x, yy, w, h, lab, val, o = {}) {
    box(x, yy, w, h);
    label(x + 4, yy + 9, lab);
    const size = o.size || 9.5;
    if (o.center) {
      pdf.setFont('helvetica', 'normal'); pdf.setFontSize(size);
      const lines = pdf.splitTextToSize(clean(val), w - 10).slice(0, Math.max(1, Math.floor((h - 12) / (size + 1.5))));
      pdf.text(lines, x + w / 2, yy + 21, { align: 'center' });
    } else {
      value(x + 7, yy + 21, w - 12, h - 14, val, size);
    }
  }
  function cb(x, yy, text, checked, size = 8) {
    pdf.setDrawColor(0); pdf.setLineWidth(0.6); pdf.rect(x, yy, size, size);
    if (checked) {
      pdf.setLineWidth(1.4);
      pdf.line(x + 1.5, yy + size / 2, x + size / 2 - 0.3, yy + size - 1.2);
      pdf.line(x + size / 2 - 0.3, yy + size - 1.2, x + size + 2.5, yy - 2.5);
      pdf.setLineWidth(0.6);
    }
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8.5);
    pdf.text(clean(text), x + size + 4, yy + size - 0.6);
  }

  // =============================== PAGE 1 ===============================
  newPage(true);
  const lp = pdf.getImageProperties('data:image/png;base64,' + IFAR_LOGO_BASE64);
  const lh = 34, lw = lh * lp.width / lp.height;
  pdf.addImage('data:image/png;base64,' + IFAR_LOGO_BASE64, 'PNG', M + 6, y, lw, lh);
  const tx = M + lw + 20;
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(12.5);
  pdf.text('TSI WEALTH PLANNERS SDN BHD', tx, y + 12);
  const nw = pdf.getTextWidth('TSI WEALTH PLANNERS SDN BHD');
  pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8); pdf.text('(1296105-W)', tx + nw + 4, y + 12);
  pdf.setFontSize(8);
  pdf.text('D-20-3A, Tower 1, Menara Suezcap KL Gateway, Bangsar South, 59200 Kuala Lumpur', tx, y + 23);
  pdf.text('Tel No.: 03-2303 1987   Email: admin@tsiwealth.com / adviser.dev@tsiwealth.com', tx, y + 33);
  y += 44;

  box(M, y, CW, 34);
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(10);
  pdf.text('ISLAMIC FINANCIAL ADVISER REPRESENTATIVE', PW / 2, y + 14, { align: 'center' });
  pdf.text('APPLICATION FORM', PW / 2, y + 27, { align: 'center' });
  y += 34;

  bar('APPLICANT PARTICULARS');
  const title = fd.title === 'Others' ? fd.titleOther : fd.title;
  const nameW = CW * 0.58, rightW = CW - nameW;
  field(M, y, nameW, 56, `Name as in NRIC (Mr/Mrs/Ms/Others: ${title || ''})`, fd.name);
  field(M + nameW, y, rightW, 28, 'Mobile Phone No.', fd.mobile);
  field(M + nameW, y + 28, rightW, 28, 'NRIC/Passport No.', fd.nric);
  y += 56;

  // Nationality / Race / Religion
  const w1 = CW * 0.30, w2 = CW * 0.30, w3 = CW - w1 - w2, rh = 74;
  box(M, y, w1, rh); box(M + w1, y, w2, rh); box(M + w1 + w2, y, w3, rh);
  label(M + 4, y + 9, 'Nationality'); label(M + w1 + 4, y + 9, 'Race'); label(M + w1 + w2 + 4, y + 9, 'Religion');
  cb(M + 8, y + 16, 'Malaysian', fd.nationality === 'Malaysian');
  cb(M + 8, y + 31, 'Singaporean', fd.nationality === 'Singaporean');
  cb(M + 8, y + 46, 'Others (Specify)', fd.nationality === 'Others');
  if (fd.nationality === 'Others') value(M + 10, y + 69, w1 - 14, 12, fd.nationalityOther, 8.5);
  cb(M + w1 + 8, y + 16, 'Malay', fd.race === 'Malay');
  cb(M + w1 + 8, y + 28, 'Chinese', fd.race === 'Chinese');
  cb(M + w1 + 8, y + 40, 'Indian', fd.race === 'Indian');
  cb(M + w1 + 8, y + 52, 'Others, please specify:', fd.race === 'Others');
  if (fd.race === 'Others') value(M + w1 + 10, y + 69, w2 - 14, 12, fd.raceOther, 8.5);
  const rx = M + w1 + w2;
  cb(rx + 8, y + 16, 'Islam', fd.religion === 'Islam');
  cb(rx + 8, y + 28, 'Hindu', fd.religion === 'Hindu');
  cb(rx + 8, y + 40, 'Buddhist', fd.religion === 'Buddhist');
  cb(rx + 8, y + 52, 'Christian', fd.religion === 'Christian');
  cb(rx + w3 / 2, y + 16, 'Others, please', fd.religion === 'Others');
  pdf.setFontSize(8.5); pdf.text('specify:', rx + w3 / 2 + 12, y + 35);
  if (fd.religion === 'Others') value(rx + w3 / 2 + 2, y + 50, w3 / 2 - 8, 22, fd.religionOther, 8.5);
  y += rh;

  // Marital status / addresses
  const mw = CW * 0.22, ah = 40;
  box(M, y, mw, ah * 2);
  label(M + 4, y + 9, 'Marital Status');
  cb(M + 8, y + 16, 'Single', fd.marital === 'Single');
  cb(M + 8, y + 30, 'Married', fd.marital === 'Married');
  cb(M + 8, y + 44, 'Divorced', fd.marital === 'Divorced');
  cb(M + 8, y + 58, 'Separated', fd.marital === 'Separated');
  cb(M + mw / 2 + 8, y + 16, 'Widowed', fd.marital === 'Widowed');
  const perm = fd.permSame ? fd.corrAddress : fd.permAddress;
  field(M + mw, y, CW - mw, ah, 'Correspondence Address', fd.corrAddress, { size: 8.5 });
  field(M + mw, y + ah, CW - mw, ah, 'Permanent Address', perm, { size: 8.5 });
  y += ah * 2;

  // Occupation row
  field(M, y, CW * 0.28, 30, 'Occupation', fd.occupation);
  field(M + CW * 0.28, y, CW * 0.47, 30, 'Office Address', fd.officeAddress, { size: 8.5 });
  field(M + CW * 0.75, y, CW * 0.25, 30, 'Office Phone No.', fd.officePhone);
  y += 30;

  // Existing agent
  box(M, y, CW, 36);
  pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8.5);
  pdf.text('Are you an existing insurance / Takaful agent or currently approved IFAR/FAR with other IFA/FA Company?', M + 5, y + 12);
  cb(M + 10, y + 21, 'Yes (please provide details below)', fd.existingAgent === 'Yes');
  cb(M + 230, y + 21, 'No', fd.existingAgent === 'No');
  y += 36;
  pdf.setFillColor(235, 235, 235); pdf.rect(M, y, CW, 14, 'FD');
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(8.5);
  pdf.text('Name of Principal Companies', PW / 2, y + 10, { align: 'center' });
  y += 14;
  [['Life Insurance Company', pr.life], ['General Insurance Company(ies)', pr.general], ['Takaful Operator', pr.takaful], ['IFA/FA Company', pr.ifa]].forEach(([l, v]) => {
    box(M, y, CW * 0.36, 15); box(M + CW * 0.36, y, CW * 0.64, 15);
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8.5); pdf.text(l, M + 5, y + 10.5);
    value(M + CW * 0.36 + 5, y + 10.5, CW * 0.64 - 10, 12, fd.existingAgent === 'Yes' ? v : '', 8.5);
    y += 15;
  });

  const hw = CW * 0.5;
  field(M, y, hw, 32, 'MFPC/IBFIM/FPAM Membership No', fd.membershipNo);
  field(M + hw, y, hw, 32, 'Email Address', fd.email);
  y += 32;

  // Family details
  bar('Family Details');
  pdf.setFillColor(245, 245, 245); pdf.rect(M, y, CW, 12, 'FD');
  pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8); pdf.text('Next of Kin', M + 5, y + 9); y += 12;
  const a = CW * 0.40, b = CW * 0.30, c = CW * 0.30;
  field(M, y, a, 32, 'Name', nok.name);
  field(M + a, y, b, 32, 'Relationship', nok.relationship);
  field(M + a + b, y, c, 32, 'Contact No.', nok.contact);
  y += 32;
  field(M, y, CW, 32, 'Address', nok.sameAsCorr ? fd.corrAddress : nok.address, { size: 8.5 });
  y += 32;

  box(M, y, CW, 96);
  pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8.5);
  const spQ = pdf.splitTextToSize('Is your spouse at present representing this Company or, any other Takaful Operator as a Tied Agent, or IFAR/FAR at any other IFA/FA Company?', CW - 12);
  pdf.text(spQ, M + 6, y + 12);
  const spYes = fd.marital === 'Married' && fd.spouseRep === 'Yes';
  const spNo = fd.marital === 'Married' && fd.spouseRep === 'No';
  cb(M + 14, y + 36, 'Yes (please provide details below)', spYes);
  cb(M + 250, y + 36, 'No', spNo);
  const line = (txt, val, yy) => {
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8.5); pdf.text(txt, M + 8, yy);
    const lx = M + 8 + pdf.getTextWidth(txt) + 4;
    pdf.setLineWidth(0.4); pdf.line(lx, yy + 1.5, M + CW - 14, yy + 1.5);
    if (spYes && val) { pdf.setFontSize(9); pdf.text(clean(val), lx + 3, yy - 0.5); }
  };
  line('Takaful Agent/FAR Code No.', fd.spouseCode, y + 58);
  line('Name of company', fd.spouseCompany, y + 74);
  line('Position', fd.spousePosition, y + 90);
  y += 96;

  // =============================== PAGE 2 ===============================
  newPage();
  function triTable(titleText, heads, widths, rows, minRows, rowH, keys, centerFrom) {
    bar(titleText);
    ensure(16 + rowH);
    let x = M;
    heads.forEach((h, i) => {
      box(x, y, widths[i], 16);
      pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8);
      pdf.text(h, x + widths[i] / 2, y + 11, { align: 'center' });
      x += widths[i];
    });
    y += 16;
    const n = Math.max(minRows, rows.length);
    for (let i = 0; i < n; i++) {
      ensure(rowH);
      const r = rows[i] || {};
      x = M;
      keys.forEach((k, j) => {
        box(x, y, widths[j], rowH);
        pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9);
        const lines = pdf.splitTextToSize(clean(r[k] || ''), widths[j] - 10).slice(0, 2);
        const base = y + rowH / 2 + (lines.length > 1 ? -2 : 3);
        if (j >= centerFrom) pdf.text(lines, x + widths[j] / 2, base, { align: 'center' });
        else pdf.text(lines, x + 6, base);
        x += widths[j];
      });
      y += rowH;
    }
    y += 10;
  }
  triTable('EMPLOYMENT HISTORY', ['Name of Company/Address', 'Position Held', 'Start - End'], [CW * 0.46, CW * 0.30, CW * 0.24], fd.employment || [], 4, 28, ['company', 'position', 'period'], 1);
  triTable('EDUCATION BACKGROUND', ['Name of Institution', 'Academic Qualification', 'Year'], [CW * 0.38, CW * 0.40, CW * 0.22], fd.education || [], 4, 28, ['institution', 'qualification', 'year'], 1);

  bar('BANK ACCOUNT INFORMATION', '(For Payment of Fees/Commissions)');
  [['Bank Name:', bank.name], ['Bank Account Number:', bank.accountNo], ['Branch:', bank.branch], ['Income Tax Number:', bank.taxNo]].forEach(([l, v]) => {
    ensure(30); field(M, y, CW, 30, l, v); y += 30;
  });
  y += 10;
  triTable('REFERENCES', ['Name', 'Designation', 'Telephone No.'], [CW * 0.38, CW * 0.38, CW * 0.24], fd.references || [], 3, 28, ['name', 'designation', 'phone'], 1);

  // =============================== PAGE 3 ===============================
  newPage();
  bar('APPLICATION CHECKLIST');
  const has = k => (files[k] || []).length > 0;
  const centerHead = (t) => { pdf.setFont('helvetica', 'bold'); pdf.setFontSize(9.5); pdf.text(t, PW / 2, y, { align: 'center' }); const tw = pdf.getTextWidth(t); pdf.setLineWidth(0.7); pdf.line(PW / 2 - tw / 2, y + 1.5, PW / 2 + tw / 2, y + 1.5); };
  y += 16; centerHead('Documents to be enclosed with this checklist'); y += 14;
  const item = (n, txt, checked, sub) => {
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8.5);
    pdf.text(String(n), M + 40, y + 8);
    const lines = pdf.splitTextToSize(txt, CW - 150);
    pdf.text(lines, M + 66, y + 8);
    let h = lines.length * 10;
    if (sub) { pdf.setFont('helvetica', 'italic'); pdf.setFontSize(7.5); const sl = pdf.splitTextToSize(sub, CW - 150); pdf.text(sl, M + 66, y + 8 + h); h += sl.length * 9; }
    cb(PW - M - 52, y + 1, '', checked, 10);
    y += Math.max(h, 12) + 5;
  };
  item(1, 'Two recent passport sized colour photograph', false);
  item(2, 'Copy of NRIC (colour, front & back)', has('nric'));
  item(3, 'Certified true copy of academic and/or professional certificates.', has('certificates'), '(IC and certificates are to be certified by a Commissioner for Oaths or a lawyer)');
  item(4, 'Copy of authorization card, Insurance Authority Card & FIMM Card (if any)', false);
  item(5, 'Proof of valid membership FPAM / MFPC', false);
  item(6, 'Copy of Professional Qualification Certificate (ShRFP /IFP)', has('prof_cert'));
  y += 12; centerHead('Documents to be completed by applicant'); y += 14;
  item(1, 'BNM JKAP Form', false);
  item(2, 'TSIWP Islamic Financial Adviser Representation Application Form', true);
  item(3, 'Islamic Financial Adviser Representative Agreement (duly completed & signed in duplicate)', false);
  item(4, 'Copy of Central Credit Reference Information System (CCRIS) Report', false);
  y += 4;

  bar('PAYMENT (Cheque or by Funds Transfer)');
  y += 14;
  pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8.5);
  pdf.text('1', M + 40, y); pdf.text('IFAR License Application fee*', M + 66, y);
  pdf.setFont('helvetica', 'bold'); pdf.text('RM 200', M + 66 + 132, y);
  pdf.setFont('helvetica', 'italic'); pdf.setFontSize(7.5);
  pdf.text('*inclusive complimentary 1 box of business card', M + 66, y + 10);
  y += 28;
  pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8.5);
  pdf.text('Note:', M + 20, y);
  pdf.text('1   All cheques must be crossed and made payable to TSI Wealth Planners Sdn Bhd; or', M + 46, y + 11);
  pdf.text('2   Bank-in via Maybank Account No: 564481-414075 (please provide copy of the bank-in slip)', M + 46, y + 22);
  y += 34;

  bar('DECLARATION');
  y += 14;
  const decl = [
    'I hereby confirm my interest to appointed an Islamic Financial Adviser Representative of TSI Wealth Planners Sdn Bhd (TSIWP) and hereby declare that to the best of my knowledge and belief, the particulars given above are true.',
    'I fully understand that any misrepresentation herein by me could result in disciplinary action, including termination from the Company.',
    'I also hereby authorise TSIWP to obtain any information it requires including but not limited to Credit Information from RAM Credit Information Sdn Bhd (RAMCI) and/or any relevant sources or person to process my application and agree to hold TSIWP free and harmless from any liability whatsoever arising therefrom.',
    'I further agree to abide by the rules and regulations set by TSIWP and understand that the rules and regulations may change from time to time at the discretion of TSIWP notice of which will be forwarded to me.'
  ];
  pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8.5);
  decl.forEach(p => { const ls = pdf.splitTextToSize(p, CW - 8); pdf.text(ls, M + 4, y); y += ls.length * 10.5 + 5; });
  y += 6;
  pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9);
  pdf.text('Signature of applicant:', M + 4, y + 26);
  const sx = M + 4 + pdf.getTextWidth('Signature of applicant:') + 6;
  pdf.setLineWidth(0.5); pdf.line(sx, y + 30, sx + 190, y + 30);
  if (app.applicant_signature) { try { pdf.addImage(app.applicant_signature, 'PNG', sx + 6, y - 6, 120, 36); } catch (e) { /* ignore */ } }
  pdf.text('Date:', sx + 215, y + 26);
  pdf.line(sx + 240, y + 30, PW - M - 4, y + 30);
  pdf.text(fmtD(app.submitted_at || new Date()), sx + 246, y + 26);
  y += 46;

  // Official use
  box(M, y, CW, 16); pdf.setFont('helvetica', 'bold'); pdf.setFontSize(9);
  pdf.text('FOR OFFICIAL USE ONLY', PW / 2, y + 11.5, { align: 'center' });
  y += 16;
  const o3 = CW / 3;
  field(M, y, o3, 34, 'Recruited/Referred by', app.recruiter_name);
  field(M + o3, y, o3, 34, 'Verified by & Date', official.verifiedBy);
  field(M + 2 * o3, y, o3, 34, 'Approved by & Date', official.approvedBy);
  y += 34;
  field(M, y, CW / 2, 34, 'Wealth Planner Rank', official.rank);
  field(M + CW / 2, y, CW / 2, 34, 'Wealth Planner Code', official.code);
  y += 34;
  field(M, y, CW, 56, 'Missing Documents/Comments (if any):', official.comments, { size: 8.5 });
  y += 56;

  // =============================== APPENDIX ===============================
  for (const slot of IFAR_FILE_SLOTS) {
    for (const f of (files[slot.key] || [])) {
      let pages;
      try {
        const blob = await loadFile(f.path);
        pages = await prepareFile(blob, f);
      } catch (e) {
        pages = [];
        newPage();
        pdf.setFont('helvetica', 'bold'); pdf.setFontSize(11);
        pdf.text(clean(ifarSlotTitle(slot)), M, y + 8);
        pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9); pdf.setTextColor(180, 0, 0);
        pdf.text(clean(`File could not be embedded: ${f.name} (${e.message || e})`), M, y + 26);
        pdf.setTextColor(0);
      }
      pages.forEach((pg, idx) => {
        newPage();
        pdf.setFont('helvetica', 'bold'); pdf.setFontSize(11);
        pdf.text(clean(ifarSlotTitle(slot)), M, y + 8);
        pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8.5); pdf.setTextColor(90);
        pdf.text(clean(`File: ${f.name}${pages.length > 1 ? `  (page ${idx + 1} of ${pages.length}${pages.truncated ? ', first ' + pages.length + ' pages shown' : ''})` : ''}`), M, y + 21);
        pdf.setTextColor(0);
        const top = y + 32, maxW = CW, maxH = PH - top - 40;
        const sc = Math.min(maxW / pg.w, maxH / pg.h);
        const dw = pg.w * sc, dh = pg.h * sc;
        pdf.addImage(pg.dataUrl, 'JPEG', M + (maxW - dw) / 2, top, dw, dh, undefined, 'FAST');
        pdf.setDrawColor(190); pdf.setLineWidth(0.5); pdf.rect(M + (maxW - dw) / 2, top, dw, dh);
      });
    }
  }

  // =============================== AUDIT TRAIL ===============================
  const events = Array.isArray(opts.auditEvents) ? opts.auditEvents : [];
  if (events.length) {
    newPage();
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(14); pdf.text('AUDIT TRAIL', M, y + 10);
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8); pdf.setTextColor(90);
    pdf.text(`Application Ref: ${app.reference_no || '-'}`, M, y + 26);
    pdf.text(`Applicant: ${clean(fd.name || app.candidate_email || '-')}`, M, y + 38);
    pdf.setTextColor(0);
    y += 56;
    events.forEach((e, i) => {
      const text = clean(ifarAuditLabel(e));
      const lines = pdf.splitTextToSize(`${i + 1}. ${text}`, CW);
      ensure(lines.length * 11 + 28);
      pdf.setDrawColor(210); pdf.line(M, y, PW - M, y);
      y += 13;
      pdf.setFont('helvetica', 'bold'); pdf.setFontSize(9); pdf.text(lines, M, y);
      y += (lines.length - 1) * 11;
      pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8);
      pdf.text(`Actor: ${clean(e.actor_label || e.actor_type || '-')}`, M + 16, y + 12);
      pdf.text(`Timestamp: ${fmtDT(e.occurred_at)}`, M + 16, y + 23);
      y += 34;
    });
  }

  // Footer on every page
  const total = pdf.internal.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    pdf.setPage(i);
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(7); pdf.setTextColor(120);
    pdf.text(`TSI Wealth Planners Sdn Bhd  |  IFAR Application ${app.reference_no || ''}  |  Page ${i} of ${total}`, PW / 2, PH - 16, { align: 'center' });
    pdf.setTextColor(0);
  }

  const safeName = String(fd.name || app.candidate_email || 'applicant').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 40);
  const filename = `IFAR-Application-${app.reference_no || 'draft'}-${safeName}.pdf`;
  return { pdf, filename, blob: pdf.output('blob') };
}
