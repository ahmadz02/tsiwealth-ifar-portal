// Shared helpers for the IFAR Registration module (dashboard, admin page, candidate form)
const IFAR_BUCKET = 'ifar-application-files';

// Document slots that must be uploaded online (checklist items 2, 3 and 6)
const IFAR_FILE_SLOTS = [
  { key: 'nric',         item: 2, label: 'NRIC copy – front and back on one page (colour)',          multi: false, flag: 'doc_nric', step: 'docs',
    hint: 'Upload a copy of your IC showing both the front and the back on a single page. Please make sure it is in colour, sharp and fully readable.' },
  { key: 'certificates', item: 3, label: 'Certified true copy of academic and/or professional certificates', multi: true,  flag: 'doc_certificates' },
  { key: 'prof_cert',    item: 6, label: 'Professional Qualification Certificate (ShRFP / IFP)',     multi: true,  flag: 'doc_prof' },
  { key: 'payment_proof', item: null, label: 'Proof of Payment (RM 200 application fee)',            multi: false, flag: 'doc_payment', step: 'declaration',
    hint: 'Upload the bank-in slip, transfer confirmation or a copy of the cheque.' }
];
IFAR_FILE_SLOTS.forEach(s => { if (!s.step) s.step = 'docs'; });
function ifarSlotTitle(s) { return s.item ? `Checklist Item ${s.item} - ${s.label}` : s.label; }

// Sections a reviewer can flag when returning an application
const IFAR_FLAG_SECTIONS = {
  particulars: 'Applicant particulars',
  family: 'Family details',
  employment_education: 'Employment history & education',
  bank_references: 'Bank account & references',
  doc_nric: 'NRIC copy (checklist item 2)',
  doc_certificates: 'Certificates (checklist item 3)',
 doc_payment: 'Proof of payment (Step 6)',
  doc_prof: 'ShRFP / IFP certificate (checklist item 6)',
  signature: 'Declaration & signature'
};

const IFAR_STATUS = {
  INVITED:    { label: 'Invited',           cls: 'bg-slate-100 text-slate-700 border-slate-200' },
  OPENED:     { label: 'Opened',            cls: 'bg-sky-50 text-sky-700 border-sky-200' },
  DRAFT:      { label: 'In Progress',       cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  SUBMITTED:  { label: 'Submitted – Review', cls: 'bg-blue-50 text-blue-700 border-blue-200' },
  RETURNED:   { label: 'Returned',          cls: 'bg-rose-50 text-rose-700 border-rose-200' },
  SENT_TO_AD: { label: 'With AD',           cls: 'bg-purple-50 text-purple-700 border-purple-200' },
  CLOSED:     { label: 'Closed',            cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' }
};

const IFAR_AUDIT_LABELS = {
  CREATED: 'Invitation created',
  EMAIL_SENT: 'Email sent',
  CANDIDATE_OPENED: 'Candidate opened the link',
  DRAFT_SAVED: 'Candidate started the form',
  CANDIDATE_SUBMITTED: 'Candidate submitted the application',
  CANDIDATE_RESUBMITTED: 'Candidate resubmitted after correction',
  RETURNED: 'Returned for correction',
  EXTENDED: 'Link extended by 30 days',
  SENT_TO_AD: 'Sent to AD',
  OFFICIAL_USE_SAVED: 'Official-use details saved',
  CLOSED: 'Application closed',
  INTERIM_LETTER: 'Interim letter issued',
  SENT_TO_BNM: 'Sent to BNM'
};

function ifarEsc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
}

function ifarFmtDate(v, withTime) {
  if (!v) return '-';
  const d = new Date(v);
  if (isNaN(d)) return String(v);
  return withTime
    ? d.toLocaleString('en-MY', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('en-MY', { day: '2-digit', month: 'short', year: 'numeric' });
}

function ifarAuditLabel(e) {
  if (e.event_type === 'EMAIL_SENT') {
    const p = e.metadata && e.metadata.purpose;
    const map = {
      CANDIDATE_INVITE: 'Invitation email sent to candidate',
      CANDIDATE_RETURN: 'Return notice emailed to candidate',
      RECRUITER_SUBMITTED_NOTICE: 'Submission notice emailed to IFAR',
      AD_APPLICATION_PDF: 'Application PDF emailed to AD'
    };
    return map[p] || 'Email sent';
  }
  if (e.event_type === 'RETURNED' && e.metadata && e.metadata.reason) {
    return `Returned for correction by ${e.actor_type === 'AD' ? 'AD' : 'IFAR'}: ${e.metadata.reason}`;
  }
  return IFAR_AUDIT_LABELS[e.event_type] || e.event_type;
}

// Milestone badges (set by the AD): interim letter issued, sent to BNM
function ifarMilestoneBadges(app) {
  const b = (txt, cls) => `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold border ${cls}">${txt}</span>`;
  let h = '';
  if (app.interim_letter_at) h += b('Interim letter issued · ' + ifarFmtDate(app.interim_letter_at), 'bg-teal-50 text-teal-700 border-teal-200');
  if (app.bnm_sent_at) h += b('Sent to BNM · ' + ifarFmtDate(app.bnm_sent_at), 'bg-indigo-50 text-indigo-700 border-indigo-200');
  return h ? `<div class="flex flex-wrap gap-1 mt-1">${h}</div>` : '';
}

function ifarStatusBadge(app) {
  const s = IFAR_STATUS[app.status] || { label: app.status, cls: 'bg-slate-100 text-slate-700 border-slate-200' };
  const expired = ['INVITED', 'OPENED', 'DRAFT', 'RETURNED'].includes(app.status) && new Date(app.expires_at) < new Date();
  if (expired) {
    return `<span class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold bg-slate-200 text-slate-600 border border-slate-300">Expired</span>`;
  }
  return `<span class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold border ${s.cls}">${s.label}</span>`;
}

async function ifarOpenFile(path) {
  const { data, error } = await supabaseClient.storage.from(IFAR_BUCKET).createSignedUrl(path, 120);
  if (error) { alert('Unable to open this file: ' + error.message); return; }
  window.open(data.signedUrl, '_blank', 'noopener');
}

// Read-only summary of an application (used by the IFAR review view and the admin page)
function ifarSummaryHtml(app) {
  const fd = app.form_data || {};
  const files = app.files || {};
  const row = (label, value) => `
    <div class="bg-slate-50 border border-slate-200 rounded-lg p-2.5">
      <p class="text-[10px] uppercase font-semibold text-slate-400">${ifarEsc(label)}</p>
      <p class="text-sm text-slate-800 whitespace-pre-line break-words">${ifarEsc(value || '-')}</p>
    </div>`;
  const sec = (title, inner) => `
    <div class="space-y-2">
      <h4 class="text-xs font-bold uppercase tracking-wider brand-navy bg-slate-100 rounded px-2 py-1">${ifarEsc(title)}</h4>
      ${inner}
    </div>`;
  const grid = inner => `<div class="grid grid-cols-1 sm:grid-cols-2 gap-2">${inner}</div>`;
  const pick = (v, other) => (v === 'Others' ? `Others: ${other || '-'}` : v);
  const title = fd.title === 'Others' ? fd.titleOther : fd.title;
  const pr = fd.principals || {};
  const nok = fd.nok || {};
  const bank = fd.bank || {};

  const particulars = grid(
    row('Name as in NRIC', `${title ? title + ' ' : ''}${fd.name || ''}`) +
    row('NRIC / Passport No.', fd.nric) + row('Mobile Phone No.', fd.mobile) + row('Email', fd.email) +
    row('Nationality', pick(fd.nationality, fd.nationalityOther)) + row('Race', pick(fd.race, fd.raceOther)) +
    row('Religion', pick(fd.religion, fd.religionOther)) + row('Marital Status', fd.marital) +
    row('Correspondence Address', fd.corrAddress) + row('Permanent Address', fd.permSame ? '(Same as correspondence)  ' + (fd.corrAddress || '') : fd.permAddress) +
    row('Occupation', fd.occupation) + row('Office Address', fd.officeAddress) + row('Office Phone No.', fd.officePhone) +
    row('MFPC / IBFIM / FPAM Membership No.', fd.membershipNo) +
    row('Existing insurance / Takaful agent or IFAR/FAR with another company?', fd.existingAgent) +
    (fd.existingAgent === 'Yes'
      ? row('Life Insurance Company', pr.life) + row('General Insurance Company(ies)', pr.general) +
        row('Takaful Operator', pr.takaful) + row('IFA/FA Company', pr.ifa) : ''));

  const family = grid(
    row('Next of Kin – Name', nok.name) + row('Relationship', nok.relationship) + row('Contact No.', nok.contact) +
    row('Address', nok.sameAsCorr ? '(Same as correspondence)  ' + (fd.corrAddress || '') : nok.address) +
    (fd.marital === 'Married'
      ? row('Spouse representing this Company / other operator / IFA-FA company?', fd.spouseRep) +
        (fd.spouseRep === 'Yes' ? row('Agent/FAR Code', fd.spouseCode) + row('Company', fd.spouseCompany) + row('Position', fd.spousePosition) : '')
      : ''));

  const list = (arr, cols) => (arr && arr.length)
    ? `<div class="space-y-1">${arr.map(r => `<div class="grid grid-cols-3 gap-2 text-sm bg-slate-50 border border-slate-200 rounded-lg p-2.5">${cols.map(c => `<span class="break-words">${ifarEsc(r[c] || '-')}</span>`).join('')}</div>`).join('')}</div>`
    : '<p class="text-sm text-slate-400">None</p>';

  const docs = IFAR_FILE_SLOTS.map(s => {
    const items = files[s.key] || [];
    return `<div class="bg-slate-50 border border-slate-200 rounded-lg p-2.5">
      <p class="text-[10px] uppercase font-semibold text-slate-400">${s.item ? 'Item ' + s.item + ' – ' : ''}${ifarEsc(s.label)}</p>
      ${items.length ? items.map(f => `<button type="button" onclick="ifarOpenFile('${ifarEsc(f.path)}')" class="block text-sm brand-navy underline text-left break-all">${ifarEsc(f.name)}</button>`).join('') : '<p class="text-sm text-rose-500">Missing</p>'}
    </div>`;
  }).join('');

  return `<div class="space-y-5">
    ${sec('Applicant particulars', particulars)}
    ${sec('Family details', family)}
    ${sec('Employment history', list(fd.employment, ['company', 'position', 'period']))}
    ${sec('Education background', list(fd.education, ['institution', 'qualification', 'year']))}
    ${sec('Bank account information', grid(row('Bank Name', bank.name) + row('Bank Account Number', bank.accountNo) + row('Branch', bank.branch) + row('Income Tax Number', bank.taxNo)))}
    ${sec('References', list(fd.references, ['name', 'designation', 'phone']))}
    ${sec('Uploaded documents', `<div class="grid grid-cols-1 sm:grid-cols-2 gap-2">${docs}</div>`)}
    ${sec('Declaration', `<div class="border border-slate-200 rounded-lg p-3 bg-white">
        ${app.applicant_signature ? `<img src="${app.applicant_signature}" class="h-16 border-b border-slate-300" alt="Applicant signature">` : '<p class="text-sm text-slate-400">No signature</p>'}
        <p class="text-[11px] text-slate-400 mt-1">Submitted ${ifarFmtDate(app.submitted_at, true)}</p></div>`)}
  </div>`;
}
