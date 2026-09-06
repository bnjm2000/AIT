/* Period close and Singapore filing preparation. Loaded after accounting-workspace.js. */
const acCloseState = {tab:'checks', data:null, request:0, worksheetRequest:0, filing:null, snapshot:'', taxLines:[]};
const AC_FILING_TYPES = [['gst','GST F5'],['eci','Estimated Chargeable Income (ECI)'],['income-tax','Corporate income tax · C-S / C-S (Lite) / C'],['annual-return','ACRA annual return & financial statements'],['gst-correction','GST correction / F7'],['gst-final','Final GST return / F8'],['withholding','Withholding tax'],['employment','Employment income / AIS'],['other','Other filing']];
const AC_FILING_CHECKS = {
  scope:'Entity, period, filing obligation and portal due date confirmed',
  reconciliations:'Ledger, subledgers and relevant bank reconciliations reviewed',
  treatment:'Tax treatment, declarations and supporting schedules reviewed',
  documents:'Required statements, notes, approvals and attachments prepared',
  authority:'Filing access and authorised submitter confirmed'
};
function acTextArea(name,label,value='',extra='') { return `<label class="ac-wide-field"><span>${accountingEscape(label)}</span><textarea name="${name}" rows="3" ${extra}>${accountingEscape(value)}</textarea></label>`; }
function acClose() {
  return `<div class="ac-page-intro"><div><h3>Close & filing</h3><p>Reconcile the period → prepare working papers → review → file through the official portal → retain evidence.</p></div><div class="accounting-tools">${acButton('New filing','acOpenFiling()','write',true)}${acButton('Save report pack','acNewPack()','write')}</div></div>
    ${acTabs([['checks','Period checks'],['filings','Filing register'],['packs','Saved report packs'],['guide','Filing guide']],acCloseState.tab,id=>`acCloseState.tab='${id}';acRenderClose()`)}
    <div id="acCloseContent" aria-live="polite"><div class="loading">Checking the books…</div></div>`;
}
async function acLoadClose() {
  const request=++acCloseState.request;
  try {
    const response=await apiCall(acUrl('/api/finance/accounting/close'));
    if(request!==acCloseState.request || accountingState.tab!=='close')return;
    acCloseState.data=response.close; acRenderClose();
  } catch(error) { const node=document.getElementById('acCloseContent');if(node&&request===acCloseState.request)node.innerHTML=acNotice(error.message,'warning'); }
}
function acRenderClose() {
  const node=document.getElementById('acCloseContent'), data=acCloseState.data;
  if(!node||!data)return;
  document.querySelectorAll('#accountingBody > .ac-subtabs button').forEach((b,i)=>{const active=['checks','filings','packs','guide'][i]===acCloseState.tab;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});
  if(acCloseState.tab==='checks') {
    const unresolved=data.checks.filter(c=>c.status==='review').length;
    const appSources=(accountingState.data.sourceDocuments||[]).filter(d=>!d.posted&&d.date<=data.period.to);
    node.innerHTML=(appSources.length?acNotice(`${appSources.length} existing app source documents are not posted. Review them in Sales / Purchases → Review existing app documents.`)+acButton('Review app documents',"accountingSetTab('sources')"):'')+acPanel('Review the selected period',`${accountingDate(data.period.from)} to ${accountingDate(data.period.to)} · ${unresolved} ledger checks need review${appSources.length?' · '+appSources.length+' app documents pending':''}`,
      acTable(['Check','Result','What to review',''],data.checks.map((c,i)=>`<tr><td><strong>${accountingEscape(c.label)}</strong></td><td>${acStatus(c.status==='clear'?'clear':'review needed')}</td><td class="ac-wrap">${accountingEscape(c.detail)}</td><td>${acButton('Open',`acOpenCloseCheck(${i})`)}</td></tr>`)),
      acButton('Refresh checks','acLoadClose()')+acButton('Period lock',"acState.settingsTab='gst';accountingSetTab('settings')",'settings'))+
      acNotice('These checks identify bookkeeping exceptions. Complete the company’s financial statement disclosures and tax reviews before issuing reports. Outstanding items can be documented in each filing’s review notes.');
  } else if(acCloseState.tab==='filings') {
    const rows=[...data.filings].sort((a,b)=>a.dueDate.localeCompare(b.dueDate));
    node.innerHTML=acNotice('This register includes all filing periods. Due dates must be confirmed against the official portal. “Filed externally” records evidence entered by your team; this app does not transmit returns.')+
      acPanel('Filing register','Track preparation, ownership, review and external acknowledgements.',acTable(['Filing / period','Due date','Assigned to','Status',''],rows.map(f=>`<tr><td class="ac-wrap"><strong>${accountingEscape(f.title)}</strong><small>${accountingDate(f.period.from)} – ${accountingDate(f.period.to)}${f.yearOfAssessment?' · YA '+accountingEscape(f.yearOfAssessment):''}</small></td><td>${accountingDate(f.dueDate)}${f.dueDate<acToday()&&!['filed','not-required'].includes(f.status)?'<small class="ac-overdue">Past due · check portal</small>':''}</td><td>${accountingEscape(accountingState.data.accountingUsers?.[f.assignedTo]?.name||f.assignedTo)}</td><td>${acStatus(f.status==='filed'?'filed externally':f.status)}${f.booksChanged?'<small class="ac-overdue">Books changed since preparation</small>':''}</td><td>${acButton('Open working paper',`acOpenFiling('${f.id}')`)}</td></tr>`),'No filings recorded. Add the obligations that apply to this company.'));
  } else if(acCloseState.tab==='packs') {
    node.innerHTML=acNotice('Each pack retains the report figures and source data captured when it was created. Create a new pack after adjustments. Excel contains the schedules; the data snapshot retains drill-down records and attachment references.')+
      acPanel('Saved report packs','Preparation schedules with the period checks captured at creation.',acTable(['Pack','Period','Prepared by','Created','Downloads'],[...data.packs].reverse().map(p=>`<tr><td>${accountingEscape(p.title)}</td><td>${accountingDate(p.period.from)} – ${accountingDate(p.period.to)}</td><td>${accountingEscape(p.createdBy)}</td><td>${accountingEscape(p.createdAt.slice(0,16).replace('T',' '))} UTC</td><td><a class="accounting-link" href="/api/finance/accounting/packs/${p.id}/xlsx">Excel workbook</a> · <a class="accounting-link" href="/api/finance/accounting/packs/${p.id}/json">Data snapshot</a></td></tr>`),'No retained packs yet. Review the period, then save a report pack.'));
  } else {
    node.innerHTML=acPanel('Singapore filing guide','Confirm the company’s obligations and portal dates before adding filings. Guidance checked 5 September 2026; use the linked official pages for current requirements.',
      acTable(['Obligation / usual deadline','Preparation and submission','Official resources'],AC_FILING_TYPES.map(([type,label])=>{
        const g=data.filingGuides?.[type];if(!g)return '';
        return `<tr><td class="ac-wrap"><strong>${accountingEscape(label)}</strong><small>${accountingEscape(g.deadline)}</small></td><td class="ac-wrap">${accountingEscape(g.preparation)}</td><td class="ac-wrap">${acFilingLinks(type,g)}</td></tr>`;
      })))+acNotice('GST InvoiceNow is already required for new voluntary GST applications from 1 April 2026. Existing GST-registered businesses are phased in from April 2028 to April 2031. Confirm the company’s notified date and use an accredited provider with IRAS transmission enabled; recording a Peppol ID in Settings does not establish a connection.')+
      acNotice('Annual returns, GST returns, corporate tax returns and tax payments are separate obligations. “Filed externally” records the acknowledgement; follow up the assessed payment or refund and reconcile it to the bank and ledger.');
  }
}
function acOpenCloseCheck(index) {
  const c=acCloseState.data.checks[index];
  if(c.bankAccount)acState.bankAccount=c.bankAccount;
  if(['tasks','purchases'].includes(c.target))accountingSetTab(c.target);else acSelectReport(c.target);
}
function acNewPack() {
  const p=accountingState.data.period;
  acForm('Save report pack',acField('title','Pack name',`Accounts · ${p.to}`,'text',null,'required')+
    acField('from','Period from',p.from,'date',null,'required')+acField('to','Period to',p.to,'date',null,'required'),
    'pack-create','Save report pack','Retains Excel schedules and their source data, including review exceptions. This does not lock the period or submit a filing.');
}
function acFilingLinks(type,guide={}) {
  const portal=type==='other'?'':type==='annual-return'?'https://www.bizfile.gov.sg/':'https://mytax.iras.gov.sg/';
  const links=[...(portal?[['Open '+(type==='annual-return'?'Bizfile':'myTax Portal'),portal]]:[]),...(guide.links||[])];
  return links.map(([label,url])=>`<a class="accounting-link" target="_blank" rel="noopener noreferrer" href="${accountingAttr(url)}">${accountingEscape(label)}</a>`).join('<br>');
}
function acFilingGuide(type) {
  const guide=acCloseState.data?.filingGuides?.[type]||(acCloseState.filing?.type===type?acCloseState.filing.guide:null);
  return acNotice(guide?guide.guidance+' '+guide.preparation:'Confirm the obligation, official due date, supporting schedules and external acknowledgement.')+
    `<p>${acFilingLinks(type,guide||{})}</p>`;
}
async function acOpenFiling(id='') {
  let f;
  try {
    if(id) f=(await apiCall('/api/finance/accounting/filings/'+id)).filing;
    else f={type:accountingState.data.settings.gstRegistered?'gst':'annual-return',period:{...accountingState.data.period},assignedTo:currentUser.username,status:'draft',checklist:{}};
    acCloseState.filing=f;
    acCloseState.taxLines=JSON.parse(JSON.stringify(f.taxAdjustments||[]));
    const locked=['filed','not-required'].includes(f.status)||!acCan('write'), extra=locked?'disabled':'';
    const fields=acField('type','Filing type',f.type,'text',AC_FILING_TYPES,`${extra} onchange="acFilingTypeChanged(this)"`)+
      acField('title','Working paper title',f.title||AC_FILING_TYPES.find(t=>t[0]===f.type)[1],'text',null,`required ${extra}`)+
      acField('from','Period from',f.period.from,'date',null,`required ${extra} onchange="acFilingPeriodChanged()"`)+acField('to','Period to',f.period.to,'date',null,`required ${extra} onchange="acFilingPeriodChanged()"`)+
      acField('dueDate','Due date confirmed in portal',f.dueDate||'','date',null,`required ${extra}`)+acField('assignedTo','Assigned to',f.assignedTo,'text',acUsers(),extra)+
      acField('yearOfAssessment','Year of Assessment (for income tax)',f.yearOfAssessment||'','number',null,`min="2000" max="2200" ${extra}`)+
      acField('relatedFilingId','Related / original filing',f.relatedFilingId||'','text',[['','None'],...(acData().filings||[]).filter(r=>r.id!==id).map(r=>[r.id,`${r.title} · ${r.period.to}`])],extra);
    acModal(id?f.title:'New filing working paper',`<form id="acFilingForm" class="ac-form" onsubmit="acSaveFiling(event)">
      ${id?`<div class="ac-document-meta">${acStatus(f.status==='filed'?'filed externally':f.status)}<span>Version ${f.version} · ${accountingEscape(f.updatedBy)}</span>${f.reviewedBy?`<span>Reviewed by ${accountingEscape(f.reviewedBy)}</span>`:''}</div>`:''}
      ${f.booksChanged?acNotice('The books changed after this working paper was prepared. Refresh and review the figures again. Filed records remain unchanged; use a separate correction record where needed.','warning'):''}
      <div class="accounting-form-grid two">${fields}</div><div id="acFilingGuide">${acFilingGuide(f.type)}</div>
      <div id="acFilingWorksheet"></div>
      <div class="accounting-form-grid two">${acTextArea('notes','Working paper notes / supporting schedule references',f.notes||'',extra)}${acTextArea('reviewNotes','Review conclusions and treatment of outstanding period checks',f.reviewNotes||'',extra)}</div>
      <fieldset class="ac-filing-review"><legend>Review checklist</legend>${Object.entries(AC_FILING_CHECKS).map(([key,label])=>`<label><input type="checkbox" data-filing-check="${key}" ${f.checklist?.[key]?'checked':''} ${extra}><span>${accountingEscape(label)}</span></label>`).join('')}</fieldset>
      ${id?acAttachments('filings',id):acNotice('Save the working paper to attach computations, statements, approvals and portal acknowledgements.')}
      ${f.externalReference?acNotice(`Filed externally on ${accountingDate(f.filedDate)} · Reference ${f.externalReference} · Recorded by ${f.recordedBy}`):''}
      ${f.resolutionReason?acNotice(`No filing required · ${f.resolutionReason} · Recorded by ${f.resolvedBy}`):''}
      ${f.reviewAttachments?.length?acNotice('Package captured at review: '+f.reviewAttachments.map(a=>a.name).join(', ')):''}
      <div class="ac-form-error" role="alert"></div><div class="modal-actions">
        ${id?`<a class="btn btn-secondary compact" href="/api/finance/accounting/filings/${id}/xlsx">Export working paper</a>`:''}
        ${id&&f.status==='draft'?acButton('Mark reviewed','acReviewFiling()','approve'):''}
        ${id&&f.status==='reviewed'?acButton('Record external filing','acRecordFiling()','approve'):''}
        ${id&&['draft','reviewed'].includes(f.status)?acButton('No filing required','acFilingNotRequired()','approve'):''}
        ${acButton('Close',"closeModal('accountingModal')")}${!locked?`<button class="btn btn-primary" type="submit">${id?'Save / refresh draft':'Save draft'}</button>`:''}
      </div></form>`);
    acFilingContextFields(f,locked);
    await acRenderFilingWorksheet(f, locked);
    acCloseState.snapshot=acFilingFingerprint();
  } catch(error) {showNotification('error',error.message||'Could not open working paper');}
}
async function acRenderFilingWorksheet(f,locked) {
  const worksheetRequest=++acCloseState.worksheetRequest;
  const node=document.getElementById('acFilingWorksheet');if(!node)return;
  const disabled=locked?'disabled':'';
  if(f.type==='gst') {
    let rows=f.gstRows;
    if(!rows) {
      const data=await apiCall('/api/finance/accounting/close?'+new URLSearchParams(f.period));
      rows=data.close.gst.map(r=>r.derived?r:{...r,adjustment:r.ledger==null?(f.declarations?.[String(r.box)]??r.adjustment):(f.adjustments?.[String(r.box)]??r.adjustment)});
    }
    if(acCloseState.filing!==f || !node.isConnected || worksheetRequest!==acCloseState.worksheetRequest)return;
    node.innerHTML=acPanel('GST F5 working paper','SGD · Ledger + adjustment = proposed return. Enter zero for special declarations that do not apply.',
      acTable(['F5 box','Ledger SGD','Adjustment / declaration SGD','Proposed SGD'],rows.map(r=>`<tr data-gst-box="${r.box}" data-ledger="${r.ledger??''}"><td class="ac-wrap">Box ${r.box} · ${accountingEscape(r.label)}</td><td class="money">${acNum(r.ledger)}</td><td>${r.derived?'Calculated':`<input aria-label="Box ${r.box} ${r.ledger==null?'declaration':'adjustment'}" type="number" step="0.01" data-gst-entry="${r.ledger==null?'declaration':'adjustment'}" value="${r.adjustment??''}" oninput="acUpdateGstProposal()" ${disabled}>`}</td><td class="money" data-gst-proposal>${acNum(r.amount)}</td></tr>`)))+
      acTextArea('adjustmentReason','Adjustment explanation and supporting journal / schedule references',f.adjustmentReason||'',disabled)+
      acNotice('Working paper adjustments do not post journals. Include special claims in the relevant primary boxes as required by IRAS; declaration boxes are not added again automatically. The ledger GST report remains the unadjusted source.');
    acUpdateGstProposal();
  } else if(['eci','income-tax'].includes(f.type)) {
    let profit=f.bookProfit;
    if(profit==null) {const data=await apiCall('/api/finance/accounting/reports/profit-loss?'+new URLSearchParams(f.period));profit=data.report.rows.find(r=>r.key==='net-profit').amount;}
    if(acCloseState.filing!==f || !node.isConnected || worksheetRequest!==acCloseState.worksheetRequest)return;
    node.innerHTML=`<section class="ac-tax-worksheet" data-book-profit="${profit}"><h4>Tax reconciliation working paper</h4><p>Book profit / (loss): SGD ${acNum(profit)}. Add positive adjustments for add-backs and negative adjustments for deductions.</p><div id="acTaxLines"></div>${locked?'':acButton('Add adjustment','acAddTaxLine()')}<p id="acAdjustedProfit"></p>${acField('declaredIncome','Proposed declared income from reviewed computation (SGD)',f.declaredIncome??'','number',null,`min="0" step="0.01" ${disabled}`)}${acNotice('The reconciliation is a working schedule. Confirm the tax basis, capital allowances, loss utilisation, donations, exemptions and form eligibility in the supporting computation. Proposed declared income is entered by the accountant.')}</section>`;
    acRenderTaxLines(locked);
  } else node.innerHTML=acNotice((f.id?'Retain the prepared filing package in the attachments below.':'Save the draft, then attach the prepared filing package before review.')+(f.type==='annual-return'?' Retain the applicable filing assessment, approved financial statements and notes, and validated XBRL package where required. This screen does not generate an XBRL instance.':'')+' Submit the reviewed package through the relevant external service and retain its acknowledgement.');
}
function acFilingContextFields(f,locked=false) {
  const year=document.getElementById('acFilingForm')?.elements.yearOfAssessment;
  if(!year)return;
  const incomeTax=['eci','income-tax'].includes(f.type);
  year.closest('label').style.display=incomeTax?'':'none';
  year.disabled=locked||!incomeTax;
}
function acResetFilingChecks() {document.querySelectorAll('#acFilingForm [data-filing-check]').forEach(n=>{n.checked=false;});}
async function acFilingPeriodChanged() {
  const form=document.getElementById('acFilingForm'), f=acCloseState.filing;
  if(!form||!f)return;
  const value=acFilingValue();
  f.period={from:value.from,to:value.to};f.gstRows=null;f.bookProfit=null;
  f.adjustments=value.adjustments;f.declarations=value.declarations;
  if(value.declaredIncome!==undefined)f.declaredIncome=value.declaredIncome;
  if(value.adjustmentReason!==undefined)f.adjustmentReason=value.adjustmentReason;
  acResetFilingChecks();
  const node=document.getElementById('acFilingWorksheet');
  if(!f.period.from||!f.period.to||f.period.from>f.period.to){++acCloseState.worksheetRequest;node.innerHTML=acNotice('Choose a valid reporting period to refresh the working paper.','warning');return;}
  node.innerHTML='<div class="loading">Refreshing the working paper for the selected period…</div>';
  try {await acRenderFilingWorksheet(f,false);} catch(error) {node.innerHTML=acNotice(error.message||'Could not refresh the working paper.','warning');}
}
function acFilingTypeChanged(input) {
  const f=acCloseState.filing;
  f.type=input.value;f.gstRows=null;f.bookProfit=null;
  input.form.elements.title.value=AC_FILING_TYPES.find(t=>t[0]===input.value)[1];
  f.period={from:input.form.elements.from.value,to:input.form.elements.to.value};
  acResetFilingChecks();
  f.guide=acCloseState.data?.filingGuides?.[f.type];
  acFilingContextFields(f);
  document.getElementById('acFilingGuide').innerHTML=acFilingGuide(f.type);
  acRenderFilingWorksheet(f,false).catch(error=>showNotification('error',error.message));
}
function acUpdateGstProposal() {
  const values={};
  document.querySelectorAll('[data-gst-box]').forEach(row=>{
    const input=row.querySelector('[data-gst-entry]');if(!input)return;
    const base=row.dataset.ledger, value=input.value;
    values[row.dataset.gstBox]=base===''?(value===''?null:Number(value)):Number(base)+Number(value||0);
  });
  values[4]=[1,2,3].reduce((sum,k)=>sum+Number(values[k]||0),0); values[8]=Number(values[6]||0)-Number(values[7]||0);
  document.querySelectorAll('[data-gst-box]').forEach(row=>row.querySelector('[data-gst-proposal]').textContent=acNum(values[row.dataset.gstBox]));
}
function acCollectTaxLines() {
  if(!document.getElementById('acTaxLines'))return;
  acCloseState.taxLines=Array.from(document.querySelectorAll('[data-tax-line]')).map(row=>Object.fromEntries(Array.from(row.querySelectorAll('[data-tax-field]')).map(n=>[n.dataset.taxField,n.value])));
}
function acRenderTaxLines(locked=false) {
  const node=document.getElementById('acTaxLines');if(!node)return;
  node.innerHTML=acTable(['Adjustment','Signed amount SGD','Schedule reference',''],acCloseState.taxLines.map((r,i)=>`<tr data-tax-line><td><input data-tax-field="label" aria-label="Adjustment ${i+1}" value="${accountingAttr(r.label||'')}" required ${locked?'disabled':''}></td><td><input data-tax-field="amount" aria-label="Adjustment ${i+1} amount" type="number" step="0.01" value="${r.amount??''}" required oninput="acUpdateTaxTotal()" ${locked?'disabled':''}></td><td><input data-tax-field="reference" aria-label="Adjustment ${i+1} reference" value="${accountingAttr(r.reference||'')}" required ${locked?'disabled':''}></td><td>${locked?'':acButton('Remove',`acRemoveTaxLine(${i})`)}</td></tr>`),'No adjustments recorded. Confirm whether the accounting profit requires tax adjustments.');
  acUpdateTaxTotal();
}
function acAddTaxLine(){acCollectTaxLines();acCloseState.taxLines.push({label:'',amount:'',reference:''});acRenderTaxLines();}
function acRemoveTaxLine(index){acCollectTaxLines();acCloseState.taxLines.splice(index,1);acRenderTaxLines();}
function acUpdateTaxTotal(){const node=document.getElementById('acAdjustedProfit');if(node){acCollectTaxLines();const profit=Number(document.querySelector('[data-book-profit]').dataset.bookProfit);node.textContent='Profit after listed adjustments: SGD '+acNum(profit+acCloseState.taxLines.reduce((sum,r)=>sum+Number(r.amount||0),0));}}
function acFilingValue() {
  const form=document.getElementById('acFilingForm'); if(!form)return null;
  acCollectTaxLines();
  const value=Object.fromEntries(new FormData(form));
  value.checklist=Object.fromEntries(Array.from(form.querySelectorAll('[data-filing-check]')).map(n=>[n.dataset.filingCheck,n.checked]));
  value.adjustments={...(acCloseState.filing?.adjustments||{})};value.declarations={...(acCloseState.filing?.declarations||{})};
  if(value.declaredIncome===undefined&&acCloseState.filing?.declaredIncome!==undefined)value.declaredIncome=acCloseState.filing.declaredIncome;
  if(value.adjustmentReason===undefined&&acCloseState.filing?.adjustmentReason!==undefined)value.adjustmentReason=acCloseState.filing.adjustmentReason;
  form.querySelectorAll('[data-gst-box]').forEach(row=>{const input=row.querySelector('[data-gst-entry]');if(input)(input.dataset.gstEntry==='declaration'?value.declarations:value.adjustments)[row.dataset.gstBox]=input.value;});
  value.taxAdjustments=acCloseState.taxLines;
  return value;
}
function acFilingFingerprint(){return JSON.stringify(acFilingValue());}
function acFilingSaved(){if(acFilingFingerprint()!==acCloseState.snapshot){showNotification('error','Save the working paper changes first.');return false;}return true;}
async function acSaveFiling(event) {
  event.preventDefault(); const f=acCloseState.filing, value=acFilingValue();
  const response=await acMutate('actions/filing-save',{...value,id:f.id,version:f.version});
  if(response)await acOpenFiling(response.record.id);
}
async function acReviewFiling(){if(!acFilingSaved())return;const f=acCloseState.filing;const r=await acMutate('actions/filing-review',{id:f.id,version:f.version});if(r)acOpenFiling(f.id);}
function acRecordFiling() {
  if(!acFilingSaved())return;
  const f=acCloseState.filing, files=(acData().attachments||[]).filter(a=>a.collection==='filings'&&a.recordId===f.id);
  if(!files.length){showNotification('error','Attach the portal acknowledgement to this working paper first.');return;}
  acForm('Record external filing evidence',`<input type="hidden" name="id" value="${f.id}"><input type="hidden" name="version" value="${f.version}">`+
    acField('filedDate','Actual external filing date',acToday(),'date',null,`required max="${acToday()}"`)+acField('reference','Portal acknowledgement reference','','text',null,'required')+
    acField('attachmentId','Acknowledgement attachment','','text',files.map(a=>[a.id,a.name]),'required'),
    'filing-file','Record filing evidence','Record this after the authorised user has filed through the official portal. This button saves your evidence; it does not submit a return or pay tax.');
}
function acFilingNotRequired() {
  if(!acFilingSaved())return;
  const f=acCloseState.filing;
  acForm('Record that no filing is required',`<input type="hidden" name="id" value="${f.id}"><input type="hidden" name="version" value="${f.version}">`+
    acTextArea('reason','Assessed exemption, waiver or reason this entry is not applicable','','required'),
    'filing-not-required','Record decision','Record the accountant’s assessment and supporting reference. This does not obtain an exemption or waiver from the authority. The decision is retained in the audit trail.');
}
