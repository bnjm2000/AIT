/* Accounting workflows. Classic script loaded after accounting.js. */
const acState = {
  documentFilter: 'all', ledgerTab: 'journals', settingsTab: 'controls',
  report: 'profit-loss', reportData: null, reportRequest: 0, groupBy: 'total', compare: 'none',
  compareFrom: '', compareTo: '', contact: '', currency: 'SGD', accountCode: '', taxCode: '',
  bankAccount: '', document: null, lines: [], busy: false
};
const AC_KINDS = { quote: 'Quotation', invoice: 'Invoice', credit_note: 'Credit note', purchase_order: 'Purchase order', bill: 'Bill', vendor_credit: 'Vendor credit', expense: 'Expense', receive_money: 'Receive money' };
const AC_SALES = ['quote', 'invoice', 'credit_note', 'receive_money'];
const AC_PURCHASES = ['purchase_order', 'bill', 'vendor_credit', 'expense'];
const AC_OPEN = ['invoice', 'bill', 'credit_note', 'vendor_credit'];
function acData() { return accountingState.data?.workspace || {}; }
function acCan(permission) { return (acData().permissions || []).includes(permission); }
function acToday() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function acDateIso(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function acNum(n) { return n == null ? '—' : (Math.abs(Number(n)) < 0.005 ? 0 : Number(n)).toLocaleString('en-SG', {minimumFractionDigits: 2, maximumFractionDigits: 2}); }

function acUrl(path) { const p = accountingState.data?.period || {}; return path + (path.includes('?') ? '&' : '?') + new URLSearchParams({ from: p.from || '', to: p.to || '' }); }
function acButton(label, action, permission = '', primary = false) { return permission && !acCan(permission) ? '' : `<button type="button" class="btn ${primary ? 'btn-primary' : 'btn-secondary'} compact" onclick="${accountingAttr(action)}">${accountingEscape(label)}</button>`; }
function acStatus(status) { return `<span class="accounting-status ${['posted','approved','complete','clear','reviewed','filed externally'].includes(status) ? 'posted' : ['void','not-required'].includes(status) ? 'inactive' : 'draft'}">${accountingEscape(status)}</span>`; }
function acPanel(title, note, content, actions = '') { return `<section class="accounting-panel"><div class="accounting-panel-heading responsive"><div><h3>${accountingEscape(title)}</h3>${note ? `<p>${accountingEscape(note)}</p>` : ''}</div><div class="accounting-tools">${actions}</div></div>${content}</section>`; }
function acNotice(text, tone='neutral') { return `<div class="accounting-notice ${tone}"><span>${accountingEscape(text)}</span></div>`; }
function acEmpty(title, detail='', action='') { return `<div class="accounting-empty"><strong>${accountingEscape(title)}</strong>${detail ? `<p>${accountingEscape(detail)}</p>` : ''}${action}</div>`; }
function acTable(headers, rows, empty='No records for this view.') { return `<div class="accounting-table-scroll"><table class="accounting-table"><thead><tr>${headers.map(h => `<th>${accountingEscape(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('') || `<tr><td colspan="${headers.length}">${acEmpty(empty)}</td></tr>`}</tbody></table></div>`; }
function acTabs(items, active, handler) { return `<div class="ac-subtabs" role="group">${items.map(([id,label]) => `<button type="button" class="${active === id ? 'active' : ''}" aria-pressed="${active === id}" onclick="${accountingAttr(handler(id))}">${accountingEscape(label)}</button>`).join('')}</div>`; }
function acField(name, label, value='', type='text', options=null, extra='') {
  return `<label><span>${accountingEscape(label)}</span>${options ? `<select name="${name}" ${extra}>${options.map(o=>`<option value="${accountingAttr(o[0])}" ${String(value) === String(o[0]) ? 'selected' : ''}>${accountingEscape(o[1])}</option>`).join('')}</select>` : `<input name="${name}" type="${type}" value="${accountingAttr(value)}" ${extra}>`}</label>`;
}
function acAccounts(types=[],selected='') { return (accountingState.data?.accounts || []).filter(a => (a.active !== false || a.code===selected) && (!types.length || types.includes(a.type))).map(a=>[a.code, `${a.code} · ${a.name}`]); }
function acBankAccounts(selected='') {
  const data=accountingState.data || {}, settings=data.settings || {};
  const codes=new Set([...(settings.cashAccounts || []), settings.defaultBankAccount || '1000', selected]);
  return acAccounts(['asset'],selected).filter(([code])=>codes.has(code));
}
function acBankAccountOptions(selected='') { return acBankAccounts(selected).map(([code,label])=>`<option value="${accountingAttr(code)}" ${code===selected?'selected':''}>${accountingEscape(label)}</option>`).join(''); }
function acUsers() { return Object.entries(accountingState.data?.accountingUsers || {}).map(([id,u])=>[id,u.name]); }
function acModal(title, html) { accountingEnsureModal(); document.getElementById('accountingModalTitle').textContent=title; document.getElementById('accountingModalBody').innerHTML=html; openModal('accountingModal'); }
function acForm(title, fields, action, label='Save', intro='') {
  acModal(title, `<form class="ac-form" onsubmit="acSubmitForm(event,'${action}')">${intro ? acNotice(intro) : ''}<div class="accounting-form-grid two">${fields}</div><div class="ac-form-error" role="alert"></div><div class="modal-actions">${acButton('Cancel',"closeModal('accountingModal')")}<button class="btn btn-primary" type="submit">${accountingEscape(label)}</button></div></form>`);
}
async function acMutate(path, value={}, method='POST', close=true) {
  if (acState.busy) return null;
  acState.busy=true;
  document.querySelectorAll('#accountingModal button[type="submit"]').forEach(b=>b.disabled=true);
  try {
    const response=await apiCall(acUrl('/api/finance/accounting/'+path),method,value);
    accountingState.data=response.data;
    if(close) closeModal('accountingModal');
    renderAccounting();
    showNotification('success','Accounting records saved');
    return response;
  } catch(error) {
    const node=document.querySelector('#accountingModal .ac-form-error');
    if(node) node.textContent=error.message;
    showNotification('error',error.message || 'Could not save accounting records');
    return null;
  } finally {
    acState.busy=false;
    document.querySelectorAll('#accountingModal button[type="submit"]').forEach(b=>b.disabled=false);
  }
}
async function acSubmitForm(event,action) { event.preventDefault(); const value=Object.fromEntries(new FormData(event.target)); await acMutate('actions/'+action,value); }
function acPeriodPreset(value) {
  if(!value) return;
  const today=new Date(); let start, end=today;
  const month=Number(accountingState.data?.settings?.financialYearStartMonth || 1)-1;
  if(value==='month') start=new Date(today.getFullYear(),today.getMonth(),1);
  if(value==='last-month') { start=new Date(today.getFullYear(),today.getMonth()-1,1); end=new Date(today.getFullYear(),today.getMonth(),0); }
  if(value==='year' || value==='last-year') { const year=today.getFullYear()-(today.getMonth()<month?1:0)-(value==='last-year'?1:0); start=new Date(year,month,1); if(value==='last-year') end=new Date(year+1,month,0); }
  document.getElementById('accountingPeriodFrom').value=acDateIso(start); document.getElementById('accountingPeriodTo').value=acDateIso(end); accountingSetPeriod();
}
function acAfterRender() {
  if(['reports','gst'].includes(accountingState.tab)) acLoadReport();
  if(accountingState.tab==='close') acLoadClose();
  if(!acCan('write')) document.querySelectorAll('#accountingBody form input, #accountingBody form select, #accountingBody form button[type="submit"]').forEach(n=>n.disabled=true);
  document.querySelectorAll('#accountingBody button[onclick]').forEach(button=>{
    const action=button.getAttribute('onclick');
    if(!acCan('post') && /accounting(PostJournal|ReverseJournal|OpenSource|OpenBankMatch)/.test(action)) button.hidden=true;
    if(!acCan('write') && /accounting(OpenJournal\(\)|OpenBankImport|OpenBankTransaction|DeleteBankTransaction)/.test(action)) button.hidden=true;
    if(!acCan('settings') && /accounting(OpenAccount|ToggleAccount)/.test(action)) button.hidden=true;
  });
  if(accountingState.tab==='settings' && !acCan('settings')) document.querySelectorAll('#accountingBody .accounting-settings input, #accountingBody .accounting-settings select, #accountingBody .accounting-settings button').forEach(n=>n.disabled=true);
}
function acNewMenu() {
  acModal('New transaction', `<div class="ac-action-grid">${Object.entries(AC_KINDS).map(([id,label])=>`<button type="button" onclick="acOpenDocument('${id}')"><strong>${label}</strong><small>${['quote','purchase_order'].includes(id)?'Approve, then convert to an invoice or bill': ['expense','receive_money'].includes(id)?'Record directly against a cash account':'Save a draft, review and post to the ledger'}</small></button>`).join('')}<button type="button" onclick="accountingOpenJournal()"><strong>Journal entry</strong><small>Opening balances, adjustments and accruals</small></button></div>`);
}
function acOverview() {
  const workspace=acData();
  const submitted=(workspace.documents||[]).filter(d=>d.status==='submitted');
  const due=(workspace.tasks||[]).filter(t=>t.status!=='complete');
  const unpaid=(workspace.documents||[]).filter(d=>d.status==='posted' && ['invoice','bill'].includes(d.kind) && d.outstanding>0 && d.dueDate<acToday());
  return `<div class="ac-workflow-strip"><div><span class="ac-eyebrow">YOUR ACCOUNTING WORKSPACE</span><h3>From source documents to signed-off books</h3><p>Capture transactions, review exceptions, reconcile cash, then prepare your reports.</p></div><span class="ac-role">${accountingEscape(workspace.role || '')}</span></div>
    <div class="ac-attention-grid">${[[submitted.length,'Awaiting approval','tasks'],[unpaid.filter(d=>d.kind==='invoice').length,'Overdue customer invoices','sales'],[unpaid.filter(d=>d.kind==='bill').length,'Overdue supplier bills','purchases'],[due.length,'Open accounting tasks','tasks'],[(accountingState.data?.bankSummary?.unmatchedCount||0),'Bank items to match','banking'],[(workspace.filings||[]).filter(f=>!['filed','not-required'].includes(f.status)&&f.dueDate<acToday()).length,'Filings past due','close']].map(([count,label,tab])=>`<button type="button" onclick="acOverviewAction('${tab}')"><strong>${count}</strong><span>${label}</span><b aria-hidden="true">→</b></button>`).join('')}</div>
    ${accountingRenderOverview()}
    ${acPanel('Month-end workflow','Follow the books from capture to close.',`<ol class="ac-checklist">${[['1','Review sales & purchase drafts','sales'],['2','Match receipts and payments','banking'],['3','Run depreciation, then review FX in Settings','assets'],['4','Review trial balance, GST and statements','reports'],['5','Review period checks and prepare filing papers','close']].map(([n,label,tab])=>`<li><span>${n}</span><button class="accounting-link" onclick="accountingSetTab('${tab}')">${label}</button></li>`).join('')}</ol>`)}`;
}
function acDocuments() {
  const sales=accountingState.tab==='sales', kinds=sales?AC_SALES:AC_PURCHASES;
  const q=accountingState.search.toLowerCase();
  const rows=(acData().documents||[]).filter(d=>kinds.includes(d.kind) && (acState.documentFilter==='all'|| d.status===acState.documentFilter || d.kind===acState.documentFilter || (acState.documentFilter==='overdue'&&d.status==='posted'&&['invoice','bill'].includes(d.kind)&&d.outstanding>0&&d.dueDate<acToday())) && (!q || [d.number,d.contact,d.reference].some(v=>String(v).toLowerCase().includes(q))));
  return `<div class="ac-page-intro"><div><h3>${sales?'Sales & receivables':'Purchases & payables'}</h3><p>${sales?'Quote → invoice → payment → customer statement':'Purchase order → bill → approval → payment'}</p></div><div class="accounting-tools">${acButton('Contacts','acOpenContacts()')}${acButton(sales?'Receive payments':'Record payments',`acPaymentBatch('${sales?'sales':'purchases'}')`,'post')}${acButton(sales?'New invoice':'New bill',`acOpenDocument('${sales?'invoice':'bill'}')`,'write',true)}</div></div>
    ${acTabs([['all','All documents'],...kinds.map(k=>[k,AC_KINDS[k]]),['draft','Drafts'],['submitted','Awaiting approval'],['overdue','Overdue']],acState.documentFilter,id=>`acState.documentFilter='${id}';renderAccountingBody()`)}
    ${acPanel(sales?'Sales documents':'Purchase documents','Amounts are shown in the document currency.',acTable(['Date','Document','Contact','Status','Currency','Total','Outstanding',''],rows.map(d=>`<tr><td>${accountingDate(d.date)}</td><td><button class="accounting-link" onclick="acOpenDocument('', '${d.id}')">${accountingEscape(d.number)}</button><small>${AC_KINDS[d.kind]}</small></td><td>${accountingEscape(d.contact)}</td><td>${acStatus(d.status)}</td><td>${d.currency}</td><td class="money">${acNum(d.total)}</td><td class="money">${d.status==='posted'&&AC_OPEN.includes(d.kind)?acNum(d.outstanding):'—'}</td><td>${acButton('Open',`acOpenDocument('', '${d.id}')`)}</td></tr>`)),accountingSearchControl('Search number or contact…')+acButton('More transaction types','acNewMenu()','write'))}
    <div class="ac-footer-actions">${acButton('Review existing app documents',"accountingSetTab('sources')")}${acButton(sales?'Customer statements':'Supplier statements',`acSelectReport('${sales?'customer-statement':'supplier-statement'}')`)}</div>`;
}
function acOverviewAction(tab) {if(tab==='close')acCloseState.tab='filings';accountingSetTab(tab);if(['sales','purchases'].includes(tab)){acState.documentFilter='overdue';renderAccountingBody();}}
function acOpenDocument(kind='invoice',id='') {
  const doc=(acData().documents||[]).find(d=>d.id===id);
  acState.document=doc || {kind,date:acToday(),dueDate:acToday(),currency:'SGD',exchangeRate:1};
  acState.lines=JSON.parse(JSON.stringify(doc?.lines || [{description:'',quantity:1,unitPrice:0,taxCode:'OP',accountCode:AC_SALES.includes(kind)?'4000':'6800'}]));
  const d=acState.document, editable=(!doc || doc.status==='draft')&&acCan('write');
  const disabled=editable?'':'disabled';
  const customers=[...new Set([...(acData().contacts||[]).map(c=>c.name),...(acData().documents||[]).map(d=>d.contact)])];
  const fields=acField('kind','Document type',d.kind,'text',Object.entries(AC_KINDS),'disabled')+
    acField('number','Document number (automatic if blank)',d.number||'','text',null,disabled)+
    acField('contact','Customer / supplier',d.contact||'','text',null,`required list="acContacts" ${disabled}`)+
    acField('date','Document date',d.date,'date',null,`required ${disabled}`)+acField('dueDate', ['quote','purchase_order'].includes(d.kind)?'Valid until':'Due date',d.dueDate,'date',null,`required ${disabled}`)+
    acField('currency','Currency',d.currency,'text',null,`required pattern="[A-Za-z]{3}" maxlength="3" onchange="acDocumentCurrency(this)" ${disabled}`)+
    acField('exchangeRate','SGD per 1 unit of currency',d.exchangeRate,'number',null,`required min="0.00000001" step="any" ${disabled}`)+
    acField('priceBasis','Line prices',d.priceBasis||'exclusive','text',[['exclusive','Exclude GST'],['inclusive','Include GST']],`${disabled} onchange="acDocumentTotal()"`)+
    acField('reference','Reference / supplier invoice no.',d.reference||'','text',null,disabled)+
    (['expense','receive_money'].includes(d.kind)?acField('bankAccount','Cash account',d.bankAccount||accountingState.data.settings.defaultBankAccount,'text',acBankAccounts(d.bankAccount),disabled):'');
  let actions='';
  if(doc && ['draft','submitted'].includes(doc.status)) {
    if(doc.status==='draft') actions+=acButton('Submit for approval',`acDocumentAction('${doc.id}','submit')`,'write');
    if(doc.status==='submitted') actions+=acButton('Return to draft',`acDocumentAction('${doc.id}','return')`,'approve');
    actions+=acButton(['quote','purchase_order'].includes(doc.kind)?'Approve':'Approve & post',`acDocumentAction('${doc.id}','post')`,'post',true);
    actions+=acButton('Void',`acDocumentAction('${doc.id}','void')`,'write');
  }
  if(doc?.status==='approved' && !doc.convertedTo) actions+=acButton(d.kind==='quote'?'Convert to invoice':'Convert to bill',`acDocumentAction('${doc.id}','convert')`,'write',true);
  if(doc?.status==='posted' && AC_OPEN.includes(doc.kind) && doc.outstanding>0) actions+=acButton('Record payment / refund',`acPaymentBatch('${AC_SALES.includes(doc.kind)?'sales':'purchases'}','${doc.id}')`,'post',true);
  if(doc?.status==='posted' && ['credit_note','vendor_credit'].includes(doc.kind) && doc.outstanding>0) actions+=acButton('Apply credit',`acApplyCredit('${doc.id}')`,'post');
  if(doc?.journalId) actions+=acButton('View journal',`accountingOpenJournal('${doc.journalId}')`);
  if(doc?.status==='posted' && ['expense','receive_money'].includes(doc.kind)) actions+=acButton('Reverse incorrect entry',`acReverseCash('${doc.id}')`,'post');
  if(doc) actions+=acButton('Preview / PDF','acPrintDocument()');
  acModal(doc?doc.number:`New ${AC_KINDS[kind].toLowerCase()}`,`<form class="ac-form" onsubmit="acSaveDocument(event)">${doc?`<div class="ac-document-meta">${acStatus(doc.status)}<span>${accountingEscape(doc.createdBy)} · ${accountingDate(doc.date)}</span>${AC_OPEN.includes(doc.kind)&&doc.status==='posted'?`<strong>${doc.currency} ${acNum(doc.outstanding)} outstanding</strong>`:''}</div>`:''}<div class="accounting-form-grid three">${fields}</div><datalist id="acContacts">${customers.map(c=>`<option value="${accountingAttr(c)}"></option>`).join('')}</datalist><div id="acDocumentLines"></div>${editable?acButton('+ Add line','acAddDocumentLine()'):''}<div id="acDocumentTotal" class="ac-document-total"></div><div class="accounting-form-grid two">${acField('notes','Notes',d.notes||'','text',null,disabled)}</div>${doc?acAttachments('documents',doc.id):acNotice('Save the draft to attach invoices, receipts and other source documents.')}${doc?acDocumentPayments(doc):''}<div class="ac-form-error" role="alert"></div><div class="modal-actions">${actions}${acButton('Close',"closeModal('accountingModal')")}${editable?'<button type="submit" class="btn btn-primary">Save draft</button>':''}</div></form>`);
  acRenderDocumentLines(editable); acDocumentTotal();
  acState.documentSnapshot = acDocumentFingerprint();
}
function acDocumentCurrency(input) { input.value=input.value.toUpperCase(); const rate=input.form.elements.exchangeRate; if(input.value==='SGD') rate.value='1'; else if(rate.value==='1') rate.value=''; }
function acRenderDocumentLines(editable=true) {
  const sales=AC_SALES.includes(acState.document.kind);
  const taxes=(accountingState.data.taxCodes||[]).filter(t=>sales?['SR9','ZR','ES','OP'].includes(t.code):['TX9','TX0','BL9','BL','OP'].includes(t.code));
  document.getElementById('acDocumentLines').innerHTML=`<div class="accounting-table-scroll"><table class="accounting-table ac-line-editor"><thead><tr><th>Description</th><th>Quantity</th><th>Unit price</th><th>Account</th><th>GST</th>${accountingState.data.settings.inventoryEnabled?'<th>Stock item</th>':''}<th></th></tr></thead><tbody>${acState.lines.map((l,i)=>`<tr data-ac-line="${i}"><td><input aria-label="Line ${i+1} description" data-field="description" value="${accountingAttr(l.description)}" required ${editable?'':'disabled'}></td><td><input aria-label="Line ${i+1} quantity" data-field="quantity" type="number" min="0.000001" step="any" value="${l.quantity}" oninput="acDocumentTotal()" required ${editable?'':'disabled'}></td><td><input aria-label="Line ${i+1} unit price" data-field="unitPrice" type="number" min="0" step="any" value="${l.unitPrice}" oninput="acDocumentTotal()" required ${editable?'':'disabled'}></td><td><select aria-label="Line ${i+1} account" data-field="accountCode" ${editable?'':'disabled'}>${acAccounts(['expense','receive_money'].includes(acState.document.kind)?[]:sales?['revenue','equity','liability']:['expense','asset'],l.accountCode).map(a=>`<option value="${accountingAttr(a[0])}" ${a[0]===l.accountCode?'selected':''}>${accountingEscape(a[1])}</option>`).join('')}</select></td><td><select aria-label="Line ${i+1} GST code" data-field="taxCode" onchange="acDocumentTotal()" ${editable?'':'disabled'}>${taxes.map(t=>`<option value="${t.code}" ${t.code===l.taxCode?'selected':''}>${t.code} · ${accountingEscape(t.name)}</option>`).join('')}</select></td>${accountingState.data.settings.inventoryEnabled?`<td><select aria-label="Line ${i+1} stock item" data-field="stockItemId" ${editable?'':'disabled'}><option value="">Service / non-stock</option>${(acData().stockItems||[]).map(s=>`<option value="${s.id}" ${s.id===l.stockItemId?'selected':''}>${accountingEscape(s.sku)}</option>`).join('')}</select></td>`:''}<td>${editable?acButton('×',`acRemoveDocumentLine(${i})`):''}</td></tr>`).join('')}</tbody></table></div>`;
}
function acCollectLines() { acState.lines=Array.from(document.querySelectorAll('[data-ac-line]')).map(row=>Object.fromEntries(Array.from(row.querySelectorAll('[data-field]')).map(input=>[input.dataset.field,input.value]))); }
function acAddDocumentLine() { acCollectLines(); acState.lines.push({description:'',quantity:1,unitPrice:0,accountCode:AC_SALES.includes(acState.document.kind)?'4000':'6800',taxCode:'OP'}); acRenderDocumentLines(); }
function acRemoveDocumentLine(index) { acCollectLines(); if(acState.lines.length>1) acState.lines.splice(index,1); acRenderDocumentLines(); acDocumentTotal(); }
function acDocumentTotal() {
  acCollectLines(); let net=0,tax=0;
  const basis=document.querySelector('#accountingModal [name="priceBasis"]')?.value||acState.document.priceBasis||'exclusive';
  acState.lines.forEach(l=>{let base=Math.round(Number(l.quantity)*Number(l.unitPrice)*100)/100;let gst=0;if(['SR9','TX9','BL9'].includes(l.taxCode)){if(basis==='inclusive'){const gross=base;base=Math.round(gross/1.09*100)/100;gst=Math.round((gross-base)*100)/100;}else gst=Math.round(base*9)/100;}net+=base;tax+=gst;});
  const n=document.getElementById('acDocumentTotal');if(n)n.innerHTML=`<span>Net ${acNum(net)}</span><span>GST ${acNum(tax)}</span><strong>Total ${acNum(net+tax)}</strong><small>Prices ${basis==='inclusive'?'include':'exclude'} GST${acState.lines.some(line=>line.taxCode==='BL9')?' · BL9 tax is part of cost and cannot be claimed':''} · Final amounts calculated on save</small>`;
}
async function acSaveDocument(event) { event.preventDefault(); acCollectLines(); const old=acState.document; const value={...Object.fromEntries(new FormData(event.target)),kind:old.kind,lines:acState.lines,version:old.version}; const response=await acMutate('documents'+(old.id?'/'+old.id:''),value,old.id?'PUT':'POST'); if(response) acOpenDocument('',response.record.id); }
async function acDocumentAction(id,action) {
  if(acState.document?.id===id && acState.documentSnapshot!==acDocumentFingerprint()) { showNotification('info','Save your changes as a draft before submitting or approving this document.');return; }
  if(['post','void'].includes(action)) { const confirmed=await showAppConfirm({title:action==='post'?'Approve this document?':'Void this draft?',message:action==='post'?'The saved document will be approved. Invoices, bills, credits and cash transactions will create ledger entries.':'The saved document will be retained in the audit trail.',confirmText:action==='post'?'Approve':'Void',cancelText:'Cancel',danger:action==='void'}); if(!confirmed) return; }
  const response=await acMutate(`documents/${id}/${action}`); if(response) acOpenDocument('',response.record.convertedTo||id);
}
function acDocumentFingerprint() { const form=document.querySelector('#accountingModal .ac-form'); if(!form)return ''; acCollectLines(); return JSON.stringify([Object.fromEntries(new FormData(form)),acState.lines]); }
function acDocumentPayments(doc) {
  const rows=(acData().settlements||[]).filter(s=>s.documentId===doc.id);
  return rows.length?acPanel('Payments & credit allocations','',acTable(['Date','Reference','Amount',''],rows.map(s=>`<tr><td>${accountingDate(s.date)}</td><td>${accountingEscape(s.reference||'Payment')}${s.reversedById?'<small>Reversed</small>':''}</td><td>${doc.currency} ${acNum(s.amount)}</td><td>${s.journalId?acButton('Journal',`accountingOpenJournal('${s.journalId}')`):'Credit allocation'}${s.requestId&&!s.reversedById&&s.amount>0?acButton('Reverse payment',`acReversePayment('${s.id}')`,'post'):''}${s.allocationId&&!s.reversedById&&!s.reversalOf&&s.amount>0?acButton('Unapply credit',`acReverseCredit('${s.id}')`,'post'):''}</td></tr>`))):'';
}
function acReversePayment(id) { acForm('Reverse recorded payment',`<input type="hidden" name="id" value="${id}">`+acField('date','Reversal date',acToday(),'date',null,'required'),'reverse-payment','Post reversal','Creates an equal and opposite cash entry and restores the document balance. The original payment and historical reports are retained.'); }
function acReverseCash(id) {acForm('Correct a direct cash entry',`<input type="hidden" name="id" value="${id}">`+acField('date','Correction date',acToday(),'date',null,'required')+acField('reason','Correction reason','','text',null,'required'),'reverse-cash','Post correction','Reverses an incorrect direct expense or receive-money posting, including its GST, and retains the original. Record actual cash refunds as new transactions.');}
function acAttachments(collection,id) { const files=(acData().attachments||[]).filter(a=>a.collection===collection&&a.recordId===id); const accept='.pdf,.png,.jpg,.jpeg,.webp,.csv,.xlsx,.docx,.txt'+(collection==='filings'?',.xml,.xbrl,.zip':''); return `<section class="ac-attachments"><h4>Source documents</h4>${files.map(f=>`<a href="/api/finance/accounting/attachments/${f.id}" target="_blank" rel="noopener">${accountingSvg('source')} ${accountingEscape(f.name)} <small>${Math.ceil(f.size/1024)} KB · ${accountingEscape(f.uploadedBy)}</small></a>`).join('')||'<p>No source documents attached.</p>'}${acCan('write')?`<label class="ac-upload-label">Attach source document <input type="file" accept="${accept}" onchange="acUploadAttachment(this,'${collection}','${id}')"></label><small>Up to 10 MB per file. Files remain linked to this record for audit.</small>`:''}</section>`; }
async function acUploadAttachment(input,collection,id) { const file=input.files?.[0]; if(!file)return; if(collection==='filings' && !acFilingSaved()){input.value='';return;} if(collection==='documents' && acState.documentSnapshot!==acDocumentFingerprint()){showNotification('error','Save document changes before attaching a file.');input.value='';return;} const body=new FormData(); body.append('file',file); const response=await acMutate(`attachments/${collection}/${id}`,body,'POST',false); if(response) { if(collection==='documents') acOpenDocument('',id); else if(collection==='journals') accountingOpenJournal(id); else if(collection==='filings') acOpenFiling(id); else if(collection==='bankReconciliations') acOpenStatement(id); else acAssetDetails(id); } }
function acPaymentBatch(side,id='') {
  const kinds=side==='sales'?['invoice','credit_note']:['bill','vendor_credit'];
  const docs=(acData().documents||[]).filter(d=>d.status==='posted'&&d.outstanding>0&&kinds.includes(d.kind)&&(!id||d.id===id));
  if(!docs.length) { acModal('Record payments',acEmpty('No unpaid documents','Post an invoice or bill before allocating a payment.')); return; }
  acModal('Record payments / receipts',`<form class="ac-form" onsubmit="acSavePayments(event)">${acNotice('Enter the amount allocated to each selected document. Amounts are in document currency; the bank entry is recorded in SGD. Credits record refunds.')}<input type="hidden" name="requestId" value="${crypto.randomUUID()}"><div class="accounting-form-grid three">${acField('date','Payment date',acToday(),'date',null,'required')}${acField('bankAccount','Bank account',accountingState.data.settings.defaultBankAccount,'text',acBankAccounts())}${acField('reference','Payment / batch reference','','text',null,'required')}</div>${acTable(['Select','Document','Contact','Currency','Unpaid','Allocate','SGD per unit'],docs.map(d=>`<tr data-payment-document="${d.id}"><td><input aria-label="Select ${accountingAttr(d.number)}" data-field="selected" type="checkbox" ${id?'checked':''}></td><td>${accountingEscape(d.number)}<small>${AC_KINDS[d.kind]}</small></td><td>${accountingEscape(d.contact)}</td><td>${d.currency}</td><td>${acNum(d.outstanding)}</td><td><input aria-label="Allocation ${accountingAttr(d.number)}" data-field="amount" type="number" min="0.01" max="${d.outstanding}" step="0.01" value="${d.outstanding}"></td><td><input aria-label="Payment exchange rate ${accountingAttr(d.number)}" data-field="exchangeRate" type="number" min="0.00000001" step="any" value="${d.currency==='SGD'?1:''}" ${d.currency==='SGD'?'readonly':''}></td></tr>`))}<div class="ac-form-error" role="alert"></div><div class="modal-actions">${acButton('Cancel',"closeModal('accountingModal')")}<button type="submit" class="btn btn-primary">Record selected payments</button></div></form>`);
}
async function acSavePayments(event) { event.preventDefault(); const value=Object.fromEntries(new FormData(event.target)); value.allocations=Array.from(event.target.querySelectorAll('[data-payment-document]')).filter(r=>r.querySelector('[data-field="selected"]').checked).map(r=>({documentId:r.dataset.paymentDocument,amount:r.querySelector('[data-field="amount"]').value,exchangeRate:r.querySelector('[data-field="exchangeRate"]').value})); if(!value.allocations.length){showNotification('error','Select at least one document.');return;} await acMutate('actions/payments',value); }
function acApplyCredit(id) { const credit=acData().documents.find(d=>d.id===id); const docs=acData().documents.filter(d=>d.status==='posted'&&d.outstanding>0&&d.contact===credit.contact&&d.currency===credit.currency&&d.kind===(credit.kind==='credit_note'?'invoice':'bill')); acForm('Apply '+credit.number,`<input name="creditId" type="hidden" value="${id}">`+acField('documentId','Invoice / bill','','text',docs.map(d=>[d.id,`${d.number} · ${d.currency} ${acNum(d.outstanding)}`]),'required')+acField('date','Allocation date',acToday(),'date',null,'required')+acField('amount','Amount in '+credit.currency,credit.outstanding,'number',null,`min="0.01" max="${credit.outstanding}" step="0.01" required`),'apply-credit','Apply credit'); }
function acOpenContacts() {
  acModal('Customers & suppliers',acPanel('Contacts','Maintain contact details, UEN and Peppol IDs.',acTable(['Name','Type','Email','UEN','Peppol ID',''],(acData().contacts||[]).map(c=>`<tr><td>${accountingEscape(c.name)}</td><td>${accountingEscape(c.kind)}</td><td>${accountingEscape(c.email)}</td><td>${accountingEscape(c.uen)}</td><td>${accountingEscape(c.peppolId)}</td><td>${acButton('Edit',`acNewContact('${c.id}')`,'write')}</td></tr>`)),acButton('Add contact','acNewContact()','write')));
}
function acNewContact(id='') {
  const c=(acData().contacts||[]).find(c=>c.id===id)||{};
  acForm(id?'Edit contact':'Add contact',`<input type="hidden" name="id" value="${id}">`+acField('name','Name',c.name||'','text',null,'required')+acField('kind','Type',c.kind||'both','text',[['customer','Customer'],['supplier','Supplier'],['both','Both']])+acField('email','Email',c.email||'','email')+acField('uen','UEN',c.uen||'')+acField('peppolId','Peppol ID',c.peppolId||'')+acField('address','Address',c.address||''),'contacts','Save contact',id?'Contact names with transactions are retained for historical statements. Address and contact details can be updated.':'');
}

function accountingOpenJournal(id='') {
  if(!id&&!acCan('write')) return;
  accountingOpenJournalBase(id);
  const journal=(accountingState.data.journals||[]).find(j=>j.id===id);
  const body=document.getElementById('accountingModalBody');
  if(journal) {
    const attachmentArea=document.createElement('div');attachmentArea.className='ac-form';attachmentArea.innerHTML=acAttachments('journals',id);
    if(journal.documentId) attachmentArea.innerHTML+=acButton('Source document',`acOpenDocument('', '${journal.documentId}')`);
    attachmentArea.innerHTML+=`<details class="ac-mappings"><summary>Journal audit history</summary><p>Created by ${accountingEscape(journal.createdBy)} · ${accountingEscape(journal.createdAt)}</p><p>Last updated by ${accountingEscape(journal.updatedBy)} · ${accountingEscape(journal.updatedAt)}</p>${(journal.history||[]).map(h=>`<p>${accountingEscape(h.at)} · ${accountingEscape(h.by)} · ${accountingEscape(h.action)}</p>`).join('')}</details>`;
    body.appendChild(attachmentArea);
  }
  if(!acCan('write')) body.querySelectorAll('input,select,button[type="submit"]').forEach(n=>n.disabled=true);
  if(!acCan('post')) {body.querySelector('#accountingJournalStatus option[value="posted"]')?.remove();body.querySelectorAll('button[onclick*="ReverseJournal"]').forEach(n=>n.hidden=true);}
  if(journal&&!acJournalCanReverse(journal))body.querySelectorAll('button[onclick*="ReverseJournal"]').forEach(n=>n.hidden=true);
}
function accountingOpenBankMatch(id) {
  acModal('Reconcile statement line',`<div class="ac-action-grid"><button type="button" onclick="acMatchExisting('${id}')"><strong>Match an existing payment</strong><small>Link to a posted cash entry with the same amount. No new journal.</small></button><button type="button" onclick="accountingOpenBankMatchBase('${id}')"><strong>Record a new cash transaction</strong><small>Use for an unrecorded expense or receipt. Creates a new journal.</small></button><button type="button" onclick="acPaymentBatch('sales')"><strong>Allocate to invoices</strong><small>Record the receipt against open invoices, then match that payment here.</small></button><button type="button" onclick="acPaymentBatch('purchases')"><strong>Allocate to bills</strong><small>Record a payment against open bills, then match it to the statement.</small></button></div>`);
}

function acReportQuery() {
  return new URLSearchParams({...accountingState.data.period,groupBy:acState.groupBy,compare:acState.compare,
    compareFrom:acState.compareFrom,compareTo:acState.compareTo,contact:acState.contact,currency:acState.currency,
    accountCode:acState.accountCode,taxCode:acState.taxCode,bankAccount:acState.bankAccount});
}
function acSelectReport(name) { if(acState.report!==name)acState.contact=''; acState.report=name; accountingState.tab='reports'; renderAccounting(); }
function acReportOption(key,value) { acState[key]=value; renderAccountingBody(); }
function acReports() {
  if(accountingState.tab==='gst') acState.report='gst';
  const catalog=acData().reportCatalog||[], groups=[...new Set(catalog.map(r=>r.group))];
  const selected=catalog.find(r=>r.id===acState.report)||catalog[0];
  const comparison=['profit-loss','balance-sheet','cash-flow'].includes(acState.report);
  const contacts=[...new Set((acData().documents||[]).filter(d=>(acState.report==='supplier-statement'?AC_PURCHASES:AC_SALES).includes(d.kind)).map(d=>d.contact))];
  const currencies=[...new Set(['SGD',...(acData().documents||[]).map(d=>d.currency)])];
  return `<div class="ac-reports-layout"><aside class="ac-report-nav" aria-label="Report library"><div class="ac-report-nav-heading">REPORT LIBRARY <span>${catalog.length}</span></div>${groups.map(group=>`<h4>${accountingEscape(group)}</h4>${catalog.filter(r=>r.group===group).map(r=>`<button type="button" class="${acState.report===r.id?'active':''}" aria-current="${acState.report===r.id?'page':'false'}" onclick="acSelectReport('${r.id}')">${accountingEscape(r.name)}</button>`).join('')}`).join('')}</aside><section class="ac-report-workspace"><div class="ac-page-intro"><div><span class="ac-eyebrow">${accountingEscape(selected?.group)}</span><h3>${accountingEscape(selected?.name)}</h3><p>${accountingEscape(selected?.description)}</p></div><div class="accounting-tools"><a class="btn btn-secondary compact" href="/api/finance/accounting/reports/${acState.report}?${acReportQuery()}&format=csv">CSV</a><a class="btn btn-secondary compact" href="/api/finance/accounting/reports/${acState.report}?${acReportQuery()}&format=xlsx">Excel</a>${acButton('Print / PDF','acPrintReport()')}${acState.report==='gst'?acButton('Prepare GST filing',"accountingSetTab('close');acOpenFiling()",'write'):''}</div></div><div class="ac-report-filters">${comparison?acField('groupBy','Columns',acState.groupBy,'text',[['total','Period total'],['monthly','Monthly'],['yearly','Yearly']],"onchange=\"acReportOption('groupBy',this.value)\"")+acField('compare','Compare with',acState.compare,'text',[['none','No comparison'],['previous','Previous period'],['year','Same period last year'],['custom','Custom period']],"onchange=\"acReportOption('compare',this.value)\""):''}${comparison&&acState.compare==='custom'?acField('compareFrom','Comparison from',acState.compareFrom,'date',null,"onchange=\"acReportOption('compareFrom',this.value)\"")+acField('compareTo','Comparison to',acState.compareTo,'date',null,"onchange=\"acReportOption('compareTo',this.value)\""):''}
    ${['customer-statement','supplier-statement'].includes(acState.report)?acField('contact',acState.report==='supplier-statement'?'Supplier':'Customer',acState.contact,'text',[['','Choose contact'],...contacts.map(c=>[c,c])],"onchange=\"acReportOption('contact',this.value)\"")+acField('currency','Statement currency',acState.currency,'text',currencies.map(c=>[c,c]),"onchange=\"acReportOption('currency',this.value)\""):''}
    ${acState.report==='general-ledger'?acField('accountCode','Account',acState.accountCode,'text',[['','All accounts'],...(accountingState.data.accounts||[]).map(a=>[a.code,`${a.code} · ${a.name}${a.active===false?' (inactive)':''}`])],"onchange=\"acReportOption('accountCode',this.value)\""):''}
    ${acState.report==='gst-detail'?acField('taxCode','Tax code',acState.taxCode,'text',[['','All GST codes'],...(accountingState.data.taxCodes||[]).map(t=>[t.code,t.name])],"onchange=\"acReportOption('taxCode',this.value)\""):''}
    ${acState.report==='bank-reconciliation'?acField('bankAccount','Bank account',acState.bankAccount||accountingState.data.settings.defaultBankAccount,'text',acBankAccounts(acState.bankAccount),"onchange=\"acReportOption('bankAccount',this.value)\""):''}
    ${['ar-aging','ap-aging'].includes(acState.report)?acButton('Closing rates & revaluation',"acState.settingsTab='currencies';accountingSetTab('settings')"):''}
    </div><div id="acReportResult" aria-live="polite"><div class="loading">Preparing report…</div></div></section></div>`;
}
async function acLoadReport() {
  const requestId=++acState.reportRequest, reportName=acState.report;
  acState.reportData=null;
  if(acState.compare==='custom' && ['profit-loss','balance-sheet','cash-flow'].includes(reportName)&&(!acState.compareFrom||!acState.compareTo)) { const n=document.getElementById('acReportResult'); if(n)n.innerHTML=acNotice('Choose both comparison dates to generate the report.');return; }
  try {
    const response=await apiCall(`/api/finance/accounting/reports/${reportName}?${acReportQuery()}`);
    if(requestId!==acState.reportRequest||!['reports','gst'].includes(accountingState.tab))return;
    acState.reportData=response.report;
    const node=document.getElementById('acReportResult'); if(node) node.innerHTML=acReportHtml(response.report);
  } catch(error) { if(requestId!==acState.reportRequest)return; const node=document.getElementById('acReportResult');if(node) node.innerHTML=acNotice(error.message||'Could not generate report.','warning'); }
}
function acHasRef(ref) { return ref && (ref.documentId || ref.journalIds?.length); }
function acCellRef(row,key) {if(Object.prototype.hasOwnProperty.call(row.cellRefs||{},key))return row.cellRefs[key];return key.startsWith('period')||['comparison','variance'].includes(key)?null:row.ref;}
function acReportHtml(report,interactive=true) {
  return `<div class="ac-report-paper"><div class="ac-report-heading"><strong>${accountingEscape(report.businessName||accountingState.data.settings.businessName||currentUser?.company?.name||currentUser?.companyName||'Company books')}</strong>${report.uen?`<p>UEN ${accountingEscape(report.uen)}</p>`:''}<h3>${accountingEscape(report.title)}</h3><p>${accountingDate(report.period.from)} to ${accountingDate(report.period.to)} · ${accountingEscape(report.framework)} · ${accountingEscape(report.currency||'SGD')}</p></div><div class="accounting-table-scroll"><table class="accounting-table ac-report-table"><thead><tr>${report.columns.map(c=>`<th class="${c.format!=='text'?'money':''}">${accountingEscape(c.label)}</th>`).join('')}</tr></thead><tbody>${report.rows.map((r,index)=>`<tr class="${r.section?'ac-report-section':r.total?'ac-report-total':''}">${r.section?`<th colspan="${report.columns.length}">${accountingEscape(r.label)}</th>`:report.columns.map((c,j)=>{const value=r[c.key]; const text=value==null?'—':c.format==='money'?acNum(value):c.format==='number'?Number(value).toLocaleString('en-SG',{maximumFractionDigits:8}):accountingEscape(value); const reference=acCellRef(r,c.key); return `<td class="${c.format!=='text'?'money':''}">${interactive&&acHasRef(reference)?`<button type="button" class="ac-drill" title="View supporting entries" onclick="acDrill(${index},'${c.key}')">${text}</button>`:text}</td>`;}).join('')}</tr>`).join('')||`<tr><td colspan="${report.columns.length}">${acEmpty('No posted activity for these filters','Adjust the dates or post your reviewed transactions.')}</td></tr>`}</tbody></table></div>${interactive?'<p class="ac-report-hint">Select an underlined figure or entry to open its supporting records.</p>':''}</div>${(report.notes||[]).map(n=>acNotice(n)).join('')}`;
}
function acDrill(index,key) {
  const row=acState.reportData?.rows[index]; if(!row)return;
  const reference=acCellRef(row,key);
  if(reference?.documentId) {acOpenDocument('',reference.documentId);return;}
  const journals=(accountingState.data.journals||[]).filter(j=>reference?.journalIds?.includes(j.id));
  acModal('Supporting entries',acNotice('Report → ledger entry → source document. Posted journal history is retained.')+acTable(['Date','Journal','Description','Debit SGD','Source'],journals.map(j=>`<tr><td>${accountingDate(j.date)}</td><td><button class="accounting-link" onclick="accountingOpenJournal('${j.id}')">${accountingEscape(j.number)}</button></td><td>${accountingEscape(j.description)}</td><td class="money">${acNum(j.debitTotal)}</td><td>${j.documentId?acButton('Document',`acOpenDocument('', '${j.documentId}')`):accountingEscape(j.sourceType||'Manual')}</td></tr>`)));
}
function acPrintHtml(title,html,orientation='landscape') {
  document.getElementById('acPrintFrame')?.remove();
  const frame=document.createElement('iframe'); frame.id='acPrintFrame';frame.title='Accounting print preview';frame.style.cssText='position:fixed;width:1px;height:1px;bottom:0;right:0;border:0;';document.body.appendChild(frame);
  const doc=frame.contentDocument;doc.open();doc.write(`<!doctype html><html><head><title>${accountingEscape(title)}</title><style>body{font:11px Arial,sans-serif;color:#142a24;padding:20px}h3{font-size:20px;margin:8px 0}table{width:100%;border-collapse:collapse}th,td{padding:7px;border-bottom:1px solid #d6dfda;text-align:left;vertical-align:top}.money{text-align:right;white-space:nowrap}.ac-report-heading{margin-bottom:20px}.ac-report-section,.ac-report-total{font-weight:bold;background:#eef5f2}.accounting-notice{margin-top:14px;color:#55675f}small{display:block}.ac-document-total{margin:20px 0;text-align:right}@page{size:${orientation};margin:12mm}.ac-document-warning{padding:10px;background:#fff5dd}thead{display:table-header-group}tr{break-inside:avoid}</style></head><body>${html}</body></html>`);doc.close();frame.contentWindow.focus();frame.contentWindow.print();
}
function acPrintReport() {if(!acState.reportData){showNotification('info','Wait for the report to load.');return;}acPrintHtml(acState.reportData.title,acReportHtml(acState.reportData,false));}
async function acPrintDocument() {
  const d=acState.document;if(!d?.id)return;
  if(acState.documentSnapshot!==acDocumentFingerprint()){showNotification('info','Save your changes before previewing the document.');return;}
  try {
    const response=await apiCall(`/api/finance/accounting/documents/${encodeURIComponent(d.id)}/preview`);
    acState.documentPreview=response.html;
    acModal('Document preview · '+d.number,`<div class="ac-form"><div class="ac-footer-actions">${acButton('Back to document',`acOpenDocument('', '${d.id}')`)}<a class="btn btn-secondary compact" href="/api/finance/accounting/documents/${encodeURIComponent(d.id)}/pdf">Download PDF</a>${acButton('Print',"acPrintHtml('Accounting document',acState.documentPreview,'portrait')")}</div>${response.html}</div>`);
  } catch(error){showNotification('error',error.message||'Could not prepare the document.');}
}

function acJournalCanReverse(journal) {return journal.status==='posted'&&!journal.reversedJournalId&&journal.sourceType!=='accounting'&&!journal.documentId&&!(acData().fixedAssets||[]).some(a=>a.acquisitionJournalId===journal.id);}
function acLedger() {
  const tabs=acTabs([['journals','Journals'],['transactions','General ledger'],['accounts','Chart of accounts'],['audit','Audit trail']],acState.ledgerTab,id=>`acState.ledgerTab='${id}';renderAccountingBody()`);
  if(acState.ledgerTab==='audit')return tabs+acAudit();
  return tabs+({journals:accountingRenderJournals,transactions:accountingRenderTransactions,accounts:accountingRenderAccounts}[acState.ledgerTab]||accountingRenderJournals)();
}
function acAudit() { const entries=acData().auditTrail||[];return acPanel('Audit trail','Latest 300 changes. Full history is available in the export.',acTable(['When','User','Action','Record',''],entries.map((r,i)=>`<tr><td>${accountingEscape(r.at.replace('T',' ').slice(0,19))}</td><td>${accountingEscape(r.by)}</td><td>${accountingEscape(r.action)}</td><td class="ac-wrap">${accountingEscape(r.target)}</td><td>${acButton('Details',`acAuditDetail(${i})`)}</td></tr>`)),`<a class="btn btn-secondary compact" href="/api/finance/accounting/audit" target="_blank" rel="noopener">Full audit JSON</a>`); }
function acAuditDetail(i) {const r=acData().auditTrail[i];acModal('Audit detail',`<div class="ac-audit-detail"><strong>${accountingEscape(r.action)} · ${accountingEscape(r.by)}</strong><p>${accountingEscape(r.at)}</p><h4>Before</h4><pre>${accountingEscape(JSON.stringify(r.before,null,2))}</pre><h4>After</h4><pre>${accountingEscape(JSON.stringify(r.after,null,2))}</pre></div>`);}

function acBanking() {
  const p=accountingState.data.period;
  return `<div class="ac-page-intro"><div><h3>Banking & reconciliation</h3><p>Record payments, import statements, then match existing ledger entries.</p></div><div class="accounting-tools">${acField('bankAccount','Bank account',acState.bankAccount||accountingState.data.settings.defaultBankAccount,'text',acBankAccounts(acState.bankAccount),"onchange=\"acState.bankAccount=this.value;renderAccountingBody()\"")}${acButton('Statement closing balance','acBankClosing()','write')}${acButton('Reconciliation report',"acSelectReport('bank-reconciliation')")}</div></div>`+accountingRenderBanking()+acSavedStatements()+acNotice(`Statement and ledger movements cover ${accountingDate(p.from)} to ${accountingDate(p.to)}. A zero movement difference alone does not complete reconciliation; review unmatched items and the actual closing balance.`);
}
function acBankClosing() { acForm('Statement closing balance',acField('bankAccount','Bank account',acState.bankAccount||accountingState.data.settings.defaultBankAccount,'text',acBankAccounts(acState.bankAccount))+acField('date','Statement ending date',accountingState.data.period.to,'date',null,'required')+acField('closingBalance','Closing balance (SGD)','','number',null,'required step="0.01"')+acField('reference','Statement reference','','text',null,'required'),'bank-closing','Save closing balance'); }
function acMatchedJournalIds(bank) {return [...new Set([...(bank.journalIds||[]),bank.journalId].filter(Boolean))];}
function acMatchExisting(bankId) {
  const bank=(accountingState.data.bankTransactions||[]).find(b=>b.id===bankId);if(!bank)return;
  const matched=new Set((accountingState.data.bankTransactions||[]).filter(b=>b.status==='matched'&&b.bankAccount===bank.bankAccount).flatMap(acMatchedJournalIds));
  const candidates=(accountingState.data.journals||[]).filter(j=>j.status==='posted'&&!j.reversedJournalId&&!matched.has(j.id)).map(j=>({...j,bankAmount:j.lines.filter(l=>l.accountCode===bank.bankAccount).reduce((a,l)=>a+Math.round(Number(l.debit)*100)-Math.round(Number(l.credit)*100),0)/100})).filter(j=>Math.abs(j.bankAmount)>=0.005).sort((a,b)=>b.date.localeCompare(a.date));
  acState.bankMatch={id:bankId,amount:bank.amount};
  acModal('Match ledger payments',`<form class="ac-form" onsubmit="acSaveBankMatch(event)">${acNotice(`${bank.description} · ${accountingDate(bank.date)} · Statement SGD ${acNum(bank.amount)}. Select one payment or the payments making up this bank batch. The selected total must equal the statement amount.`)}${acTable(['Select','Date','Journal','Description','Cash movement SGD'],candidates.map(j=>`<tr><td><input type="checkbox" name="journalIds" value="${accountingAttr(j.id)}" data-bank-amount="${j.bankAmount}" aria-label="Select ${accountingAttr(j.number)}" onchange="acBankMatchTotal()"></td><td>${accountingDate(j.date)}</td><td>${accountingEscape(j.number)}</td><td>${accountingEscape(j.description)}</td><td class="money">${acNum(j.bankAmount)}</td></tr>`),'No unmatched cash entries for this bank account.')}<p id="acBankMatchTotal" aria-live="polite"></p><div class="ac-form-error" role="alert"></div><div class="modal-actions">${acButton('Cancel',"closeModal('accountingModal')")}<button class="btn btn-primary" type="submit" disabled>Match selected payments</button></div></form>`);
  acBankMatchTotal();
}
function acBankMatchTotal() {
  const form=document.querySelector('#accountingModal form');if(!form||!acState.bankMatch)return;
  const selected=[...form.querySelectorAll('[name="journalIds"]:checked')];
  const cents=selected.reduce((sum,input)=>sum+Math.round(Number(input.dataset.bankAmount)*100),0);
  const difference=Math.round(Number(acState.bankMatch.amount)*100)-cents;
  document.getElementById('acBankMatchTotal').textContent=`${selected.length} payments selected · Total SGD ${acNum(cents/100)} · Difference SGD ${acNum(difference/100)}`;
  form.querySelector('button[type="submit"]').disabled=!acCan('post')||!selected.length||difference!==0;
}
async function acSaveBankMatch(event) {event.preventDefault();const journalIds=[...event.target.querySelectorAll('[name="journalIds"]:checked')].map(n=>n.value);await acMutate('actions/bank-match-existing',{bankTransactionId:acState.bankMatch.id,journalIds});}
function acReverseCredit(id) {acForm('Unapply a credit allocation',`<input type="hidden" name="id" value="${accountingAttr(id)}">`+acField('date','Reversal date',acToday(),'date',null,'required')+acField('reason','Reason','','text',null,'required'),'reverse-credit','Unapply credit','Restores both the invoice/bill and credit balances, preserving the original allocation and historical reports. Any allocation exchange difference is reversed.');}

function acAssets() {
  const assets=acData().fixedAssets||[];
  return `<div class="ac-page-intro"><div><h3>Fixed asset register</h3><p>Link an acquisition already in the ledger, then post depreciation at month end.</p></div><div class="accounting-tools">${acButton('Depreciation schedule',"acSelectReport('fixed-assets')")}${acButton('Run depreciation','acRunDepreciation()','post')}${acButton('Register asset','acRegisterAsset()','write',true)}</div></div>${acPanel('Assets','Straight-line depreciation · monthly charge · SGD',acTable(['Asset','In service','Cost','Residual','Useful life','Depreciation posted','Book value',''],assets.map(a=>{const dep=a.depreciation.reduce((n,r)=>n+Number(r.amount),0);return `<tr><td><strong>${accountingEscape(a.name)}</strong></td><td>${accountingDate(a.inServiceDate)}</td><td class="money">${acNum(a.cost)}</td><td class="money">${acNum(a.residualValue)}</td><td>${a.usefulLifeMonths} months</td><td class="money">${acNum(dep)}</td><td class="money">${acNum(a.cost-dep)}</td><td>${acButton('Open',`acAssetDetails('${a.id}')`)}</td></tr>`;})))}${acNotice('To acquire an asset, create a bill or expense using the fixed asset account, post it, then register the asset against that journal. Registration does not post the acquisition twice.')}`;
}
function acRegisterAsset() {
  const journals=(accountingState.data.journals||[]).filter(j=>j.status==='posted'&&!j.reversedJournalId&&j.lines.some(l=>acAccounts(['asset']).some(([code])=>code===l.accountCode)&&l.debit>0));
  acForm('Register a fixed asset',acField('name','Asset name','','text',null,'required')+acField('inServiceDate','In-service date',acToday(),'date',null,'required')+acField('cost','Acquisition cost (SGD)','','number',null,'required min="0.01" step="0.01"')+acField('residualValue','Residual value (SGD)',0,'number',null,'required min="0" step="0.01"')+acField('usefulLifeMonths','Useful life (months)',36,'number',null,'required min="1" max="1200" step="1"')+acField('acquisitionJournalId','Posted acquisition journal','','text',[['','Choose journal'],...journals.map(j=>[j.id,`${j.number} · ${j.description}`])],'required')+acField('assetAccount','Asset account','1500','text',acAccounts(['asset']))+acField('accumulatedAccount','Accumulated depreciation','1590','text',acAccounts(['asset']))+acField('depreciationAccount','Depreciation expense','6950','text',acAccounts(['expense'])),'fixed-assets','Register asset','Monthly straight-line depreciation begins at the end of the service month. Register only cost already recorded in the selected acquisition journal.');
}
function acRunDepreciation() { acForm('Post depreciation',acField('date','Depreciate through',accountingState.data.period.to,'date',null,'required'),'depreciate','Post depreciation','Posts only the additional depreciation due through this date. Repeating a run will not duplicate existing charges.'); }
function acAssetDetails(id) { const a=acData().fixedAssets.find(a=>a.id===id);acModal(a.name,acNotice(`Cost SGD ${acNum(a.cost)} · Residual SGD ${acNum(a.residualValue)} · ${a.usefulLifeMonths} months`)+acButton('Acquisition journal',`accountingOpenJournal('${a.acquisitionJournalId}')`)+acTable(['Depreciation date','Charge SGD',''],a.depreciation.map(d=>`<tr><td>${accountingDate(d.date)}</td><td>${acNum(d.amount)}</td><td>${acButton('Journal',`accountingOpenJournal('${d.journalId}')`)}</td></tr>`))+acAttachments('fixedAssets',id)); }
function acInventory() {
  if(!accountingState.data.settings.inventoryEnabled)return acPanel('Trading inventory','Optional stock accounting for trading businesses.',acEmpty('Inventory accounting is switched off','Enable it in Accounting Settings if you hold goods for sale.',acButton('Open settings',"accountingSetTab('settings')")));
  return `<div class="ac-page-intro"><div><h3>Trading inventory</h3><p>Stock on hand, weighted average cost and ledger-linked movements.</p></div><div class="accounting-tools">${acButton('Valuation report',"acSelectReport('inventory')")}${acButton('Stock adjustment','acStockAdjustment()','post')}${acButton('Add stock item','acNewStock()','write',true)}</div></div>${acPanel('Stock items','Record stock purchases on bills and stock sales on invoices.',acTable(['SKU','Item','Unit','On hand','Value SGD'],(acData().stockItems||[]).map(i=>`<tr><td>${accountingEscape(i.sku)}</td><td>${accountingEscape(i.name)}</td><td>${accountingEscape(i.uom)}</td><td>${i.quantity}</td><td class="money">${acNum(i.value)}</td></tr>`)))}${acPanel('Stock movements','Receipts increase stock; issues recognise cost of sales.',acTable(['Date','Item','Reference','Quantity','Cost SGD'],[...(acData().stockMoves||[])].reverse().map(m=>`<tr><td>${accountingDate(m.date)}</td><td>${accountingEscape(acData().stockItems.find(i=>i.id===m.itemId)?.name||'')}</td><td>${accountingEscape(m.reference)}</td><td>${m.quantity}</td><td class="money">${acNum(m.value)}</td></tr>`)))}`;
}
function acNewStock() {acForm('Add trading stock item',acField('sku','SKU','','text',null,'required')+acField('name','Item name','','text',null,'required')+acField('uom','Unit of measure','unit'),'stock-items');}
function acStockAdjustment() {acForm('Stock adjustment',acField('itemId','Stock item','','text',(acData().stockItems||[]).map(i=>[i.id,`${i.sku} · ${i.name}`]),'required')+acField('date','Movement date',acToday(),'date',null,'required')+acField('quantity','Quantity (+ receive / − issue)','','number',null,'required step="any"')+acField('unitCost','Unit cost SGD (receipts only)','','number',null,'min="0" step="any"')+acField('offsetAccount','Adjustment offset account','5000','text',acAccounts(['expense','equity']))+acField('reference','Reason / reference','','text',null,'required'),'stock-move','Post adjustment','Issues use the current weighted average cost. Negative stock is prevented. Use bills and invoices for ordinary stock purchases and sales.');}

function acTasks() {
  const pending=(acData().documents||[]).filter(d=>d.status==='submitted');
  const tasks=[...(acData().tasks||[])].sort((a,b)=>a.status.localeCompare(b.status)||a.dueDate.localeCompare(b.dueDate));
  return `<div class="ac-page-intro"><div><h3>Tasks & approvals</h3><p>Review submitted documents and keep the close moving.</p></div>${acButton('Add task','acNewTask()','write',true)}</div>${acPanel('Approval queue',accountingState.data.settings.approvalRequired?'A different accountant must approve the preparer’s documents.':'Accountants can review and post documents. Enable independent approval in Settings.',acTable(['Document','Contact','Prepared by','Submitted','Amount',''],pending.map(d=>`<tr><td>${accountingEscape(d.number)}<small>${AC_KINDS[d.kind]}</small></td><td>${accountingEscape(d.contact)}</td><td>${accountingEscape(d.createdBy)}</td><td>${accountingDate(d.submittedAt)}</td><td class="money">${d.currency} ${acNum(d.total)}</td><td>${acButton('Review',`acOpenDocument('', '${d.id}')`)}</td></tr>`),'No documents awaiting approval.'))}
    ${acPanel('Accounting tasks','Assign follow-ups and month-end work to a company user.',acTable(['Task','Assigned to','Due','Status',''],tasks.map(t=>`<tr><td>${accountingEscape(t.title)}</td><td>${accountingEscape(accountingState.data.accountingUsers[t.assignedTo]?.name||t.assignedTo)}</td><td class="${t.status!=='complete'&&t.dueDate<acToday()?'ac-overdue':''}">${accountingDate(t.dueDate)}</td><td>${acStatus(t.status)}</td><td>${acButton(t.status==='complete'?'Reopen':'Complete',`acMutate('actions/task-toggle',{id:'${t.id}'})`,'write')}</td></tr>`)))}
    ${acPanel('Recurring transactions','Generate drafts for review. Each scheduled occurrence is created once.',acTable(['Schedule','Template','Next date','Frequency','Status',''],(acData().recurring||[]).map(r=>`<tr><td>${accountingEscape(r.name)}</td><td>${accountingEscape(acData().documents.find(d=>d.id===r.documentId)?.number||'')}</td><td>${accountingDate(r.nextDate)}</td><td>Every ${r.intervalMonths} month(s)</td><td>${r.active?'Active':'Paused'}</td><td>${acButton(r.active?'Pause':'Resume',`acMutate('actions/recurring-toggle',{id:'${r.id}'})`,'write')}</td></tr>`)),acButton('Generate due drafts','acGenerateRecurring()','write')+acButton('New schedule','acNewRecurring()','write'))}`;
}
function acNewTask() {acForm('New accounting task',acField('title','Task','','text',null,'required')+acField('dueDate','Due date',acToday(),'date',null,'required')+acField('assignedTo','Assign to',currentUser?.username,'text',acUsers()),'tasks','Create task');}
function acNewRecurring() {acForm('Recurring transaction',acField('name','Schedule name','','text',null,'required')+acField('documentId','Use existing document as template','','text',(acData().documents||[]).filter(d=>d.status!=='void'&&!['credit_note','vendor_credit'].includes(d.kind)).map(d=>[d.id,`${d.number} · ${d.contact}`]),'required')+acField('nextDate','First scheduled date',acToday(),'date',null,'required')+acField('intervalMonths','Repeat every',1,'text',[[1,'Month'],[3,'Quarter'],[6,'Six months'],[12,'Year']]),'recurring','Save schedule','Run Generate due drafts to create scheduled transactions. Generated documents go through the ordinary review and posting workflow.');}
function acGenerateRecurring(){acForm('Generate recurring drafts',acField('date','Generate due through',acToday(),'date',null,'required'),'run-recurring','Generate drafts');}

function acSettings() {
  const tabs=acTabs([['controls','Books & permissions'],['gst','GST & period lock'],['currencies','Currencies'],['invoicenow','InvoiceNow']],acState.settingsTab,id=>`acState.settingsTab='${id}';renderAccountingBody()`);
  if(acState.settingsTab==='gst') return tabs+accountingRenderSettings();
  if(acState.settingsTab==='currencies') return tabs+acCurrencies();
  if(acState.settingsTab==='invoicenow') return tabs+acInvoiceNow();
  const s=accountingState.data.settings, disabled=acCan('settings')?'':'disabled';
  return tabs+`<form class="ac-controls-form" onsubmit="acSaveControls(event)">${acPanel('Company books','SGD functional currency with foreign currency source documents.',`<div class="accounting-form-grid three">${acField('reportingFramework','Financial reporting framework',s.reportingFramework,'text',[['FRS','Singapore FRS'],['SFRS(I)','SFRS(I)'],['SFRS for Small Entities','SFRS for Small Entities']],disabled)}${acField('uen','Company UEN',s.uen,'text',null,disabled)}${acField('businessName','Registered business name',s.businessName,'text',null,disabled)}${acField('businessAddress','Registered business address',s.businessAddress,'text',null,disabled)}<label class="ac-checkbox"><input name="approvalRequired" type="checkbox" ${s.approvalRequired?'checked':''} ${disabled}><span>Require independent document approval</span></label><label class="ac-checkbox"><input name="inventoryEnabled" type="checkbox" ${s.inventoryEnabled?'checked':''} ${disabled}><span>Enable trading inventory</span></label></div>`)}
    ${acPanel('Accounting access','Company admins have full access. The platform owner has separate read-only access and is intentionally omitted from this list.',acTable(['User','Application role','Accounting access'],acUsers().map(([id,name])=>{const user=accountingState.data.accountingUsers[id]||{},role=user.appRole||'user';return `<tr><td>${accountingEscape(name)}<small>${accountingEscape(id)}</small></td><td>${accountingEscape(role.charAt(0).toUpperCase()+role.slice(1))}</td><td>${user.hasAccountingAccess?acStatus('full access'):acStatus('no access')}</td></tr>`;})))}
    ${acPanel('Cash flow statement mapping','Select cash equivalents and classify counterpart accounts. Review mixed journals before issuing financial statements.',`<div class="ac-cash-accounts">${acAccounts(['asset']).map(([code,name])=>`<label class="ac-checkbox"><input type="checkbox" data-cash-account="${accountingAttr(code)}" ${(s.cashAccounts||[]).includes(code)?'checked':''} ${disabled}><span>${accountingEscape(name)}</span></label>`).join('')}</div><details class="ac-mappings"><summary>Account classifications</summary>${acTable(['Account','Cash flow activity'],acAccounts().map(([code,name])=>`<tr><td>${accountingEscape(name)}</td><td><select aria-label="Cash flow category ${accountingAttr(name)}" data-cash-mapping="${accountingAttr(code)}" ${disabled}>${[['','Automatic from account group'],['operating','Operating'],['investing','Investing'],['financing','Financing']].map(([v,label])=>`<option value="${v}" ${s.cashFlowMappings[code]===v?'selected':''}>${label}</option>`).join('')}</select></td></tr>`))}</details>`)}
    ${acGstRevenueSettings(s,disabled)}
    ${acCan('settings')?'<div class="accounting-form-actions"><button type="submit" class="btn btn-primary">Save books & permissions</button></div>':''}</form>`;
}
async function acSaveControls(event) {event.preventDefault();const form=event.target;const value=Object.fromEntries(new FormData(form));value.approvalRequired=form.elements.approvalRequired.checked;value.inventoryEnabled=form.elements.inventoryEnabled.checked;value.cashAccounts=Array.from(form.querySelectorAll('[data-cash-account]:checked')).map(n=>n.dataset.cashAccount);value.gstRevenueAccounts=Array.from(form.querySelectorAll('[data-gst-revenue]:checked')).map(n=>n.dataset.gstRevenue);value.cashFlowMappings=Object.fromEntries(Array.from(form.querySelectorAll('[data-cash-mapping]')).filter(n=>n.value).map(n=>[n.dataset.cashMapping,n.value]));await acMutate('actions/controls',value);}
function acCurrencies() {return `<div class="ac-page-intro"><div><h3>Foreign currencies</h3><p>Transactions retain their currency and booked rate. Reports are in SGD.</p></div><div class="accounting-tools">${acButton('Revalue open AR / AP','acRevalue()','post')}${acButton('Add closing rate','acNewRate()','write',true)}</div></div>${acPanel('Closing exchange rates','Enter the SGD value of one unit of foreign currency, with its source.',acTable(['Date','Currency','SGD per unit','Source'],[...(acData().exchangeRates||[])].sort((a,b)=>b.date.localeCompare(a.date)).map(r=>`<tr><td>${accountingDate(r.date)}</td><td>${r.currency}</td><td>${Number(r.rate).toLocaleString('en-SG',{maximumFractionDigits:8})}</td><td>${accountingEscape(r.source)}</td></tr>`)))}${acPanel('Posted revaluations','Unrealised exchange differences update open-item carrying values.',acTable(['Date','Document','Rate','Adjustment SGD',''],[...(acData().revaluations||[])].reverse().map(r=>`<tr><td>${accountingDate(r.date)}</td><td>${accountingEscape(acData().documents.find(d=>d.id===r.documentId)?.number||'')}</td><td>${r.rate}</td><td class="money">${acNum(r.adjustment)}</td><td>${acButton('Journal',`accountingOpenJournal('${r.journalId}')`)}</td></tr>`)))}`;}
function acNewRate(){acForm('Add closing exchange rate',acField('date','Rate date',accountingState.data.period.to,'date',null,'required')+acField('currency','Currency (e.g. USD)','','text',null,'required pattern="[A-Za-z]{3}" maxlength="3"')+acField('rate','SGD per 1 unit of currency','','number',null,'required min="0.00000001" step="any"')+acField('source','Rate source / reference','','text',null,'required'),'rates');}
function acRevalue(){acForm('Revalue open receivables & payables',acField('date','Revaluation date',accountingState.data.period.to,'date',null,'required'),'revalue','Post revaluation','Uses the latest recorded closing rate on or before this date. Only the difference from the existing carrying value is posted; repeated runs do not duplicate it.');}
function acInvoiceNow(){const s=accountingState.data.settings;return acPanel('InvoiceNow','Connection status: not connected',`<div class="ac-invoicenow"><span class="ac-connection-badge">Provider connection required</span><h3>Prepare your business for e-invoicing</h3><p>Store your UEN, Peppol ID and provider details here. Invoice transmission and IRAS delivery acknowledgements require an integration with an IMDA-accredited access-point provider.</p><ol><li>Choose an accredited provider and register your business in the Peppol directory.</li><li>Enter your company details below and add customer Peppol IDs in Contacts.</li><li>Complete provider integration and conformance testing before transmitting invoices.</li></ol><p><a href="https://www.imda.gov.sg/how-we-can-help/nationwide-e-invoicing-framework/peppol-technical-playbook" target="_blank" rel="noopener">IMDA technical playbook</a> · <a href="https://www.iras.gov.sg/taxes/goods-services-tax-(gst)/gst-invoicenow-requirement" target="_blank" rel="noopener">IRAS GST InvoiceNow requirement</a></p><form onsubmit="acSubmitForm(event,'controls')"><div class="accounting-form-grid three">${acField('uen','Company UEN',s.uen,'text',null,acCan('settings')?'':'disabled')}${acField('peppolId','Peppol ID',s.peppolId,'text',null,acCan('settings')?'':'disabled')}${acField('invoiceNowProvider','Access-point provider',s.invoiceNowProvider,'text',null,acCan('settings')?'':'disabled')}</div>${acCan('settings')?'<div class="accounting-form-actions"><button type="submit" class="btn btn-primary">Save InvoiceNow details</button></div>':''}</form></div>`);}

function acGstRevenueSettings(s,disabled) {
  return acPanel('GST Box 13 · operating revenue','Select the revenue accounts that form operating turnover. Exclude non-operating grants, disposal proceeds and other receipts where required.',`<div class="ac-cash-accounts">${(accountingState.data.accounts||[]).filter(a=>a.type==='revenue').map(a=>`<label class="ac-checkbox"><input type="checkbox" data-gst-revenue="${accountingAttr(a.code)}" ${(s.gstRevenueAccounts||[]).includes(a.code)?'checked':''} ${disabled}><span>${accountingEscape(a.code+' · '+a.name)}</span></label>`).join('')}</div>`);
}
function acSavedStatements() {
  const code=acState.bankAccount||accountingState.data.settings.defaultBankAccount;
  const rows=(acData().bankReconciliations||[]).filter(r=>r.bankAccount===code).sort((a,b)=>b.date.localeCompare(a.date));
  return acPanel('Retained statement balances','Keep the source bank statement with each recorded closing balance.',acTable(['Statement date','Closing SGD','Reference',''],rows.map(r=>`<tr><td>${accountingDate(r.date)}</td><td>${acNum(r.closingBalance)}</td><td>${accountingEscape(r.reference)}</td><td>${acButton('Statement & attachments',`acOpenStatement('${r.id}')`)}</td></tr>`),'No statement balances recorded for this bank account.'));
}
function acOpenStatement(id) {
  const r=(acData().bankReconciliations||[]).find(r=>r.id===id);if(!r)return;
  acModal('Bank statement · '+r.date,acNotice(`Account ${r.bankAccount} · Closing balance SGD ${acNum(r.closingBalance)} · ${r.reference}`)+acAttachments('bankReconciliations',id));
}
