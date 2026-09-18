/* Pure renderer/state tests. These do not sign into or automate a browser. */
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const escape = value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const context = vm.createContext({URLSearchParams,Date,Intl,console,escapeHtml:escape,escapeHtmlAttr:escape,
  currentUser:{username:'demo',companyName:'Preview company'},setTimeout,clearTimeout});
for (const file of ['accounting.js','accounting-workspace.js','accounting-close.js']) {
  vm.runInContext(fs.readFileSync('static/js/'+file,'utf8'), context);
}
vm.runInContext(`
accountingState.data={period:{from:'2026-01-01',to:'2026-03-31'},settings:{gstRevenueAccounts:['4000'],defaultBankAccount:'1000',defaultReceivableAccount:'1100',defaultPayableAccount:'2000',cashAccounts:['1000'],roles:{},cashFlowMappings:{},financialYearStartMonth:1,reportingFramework:'FRS',inventoryEnabled:true},accounts:[{code:'1000',name:'Cash',type:'asset',active:true},{code:'4000',name:'Revenue',type:'revenue',active:true}],accountingUsers:{demo:{name:'Demo'}},summary:{},journals:[],transactions:[],taxCodes:[],workspace:{role:'manager',permissions:['read','write','post','approve','settings'],documents:[],tasks:[],stockItems:[],filings:[],reportPacks:[],reportCatalog:[{id:'profit-loss',name:'Profit & Loss',group:'Financial statements',description:'Posted results'},{id:'supplier-statement',name:'Supplier Statement',group:'Receivables & payables',description:'Bills and payments'}]}};
`, context);
const rendered=[];
for (const fn of ['acOverview','acDocuments','acBanking','acLedger','acAssets','acInventory','acTasks','acSettings','acReports','acCurrencies','acInvoiceNow','acClose','accountingHeader','accountingTabs']) {
  const html=vm.runInContext(`${fn}()`,context);
  assert.equal(typeof html,'string',fn);
  assert(html.length>100,fn);
  assert(!html.includes('[object Object]'),fn);
  rendered.push(html);
}
vm.runInContext(`acState.report='supplier-statement'; accountingState.tab='reports';`,context);
const supplier=vm.runInContext('acReports()',context);
assert(supplier.includes('<span>Supplier</span>'));
assert(supplier.includes('format=xlsx'));
const controls=vm.runInContext('acSettings()',context);
assert(controls.includes('data-gst-revenue="4000"'));
const accountingHeading=vm.runInContext('accountingHeader()',context);
assert(accountingHeading.includes('Accounting <span class="accounting-beta-badge">Beta</span>'));
assert(!vm.runInContext("acCellRef({ref:{journalIds:['wrong-period']},cellRefs:{period0:null}},'period0')",context));
assert(!vm.runInContext("acCellRef({ref:{journalIds:['wrong-period']}},'period1')",context));
assert.equal(vm.runInContext("acCellRef({ref:{journalIds:['all']},cellRefs:{variance:{journalIds:['current','previous']}}},'variance').journalIds.length",context),2);
const closeNode={innerHTML:''};
context.document={getElementById:id=>id==='acCloseContent'?closeNode:null,querySelectorAll:()=>[]};
vm.runInContext(`acCloseState.data={period:accountingState.data.period,checks:[],packs:[],filings:[{id:'test-filing',type:'gst',title:'GST <unsafe>',period:accountingState.data.period,dueDate:'2026-04-30',assignedTo:'demo',status:'not-required'}]};`,context);
for (const tab of ['checks','filings','packs']) {
  vm.runInContext(`acCloseState.tab='${tab}';acRenderClose()`,context);
  rendered.push(closeNode.innerHTML);
  assert(!closeNode.innerHTML.includes('[object Object]'));
}
vm.runInContext("acCloseState.tab='filings';acRenderClose()",context);
assert(closeNode.innerHTML.includes('GST &lt;unsafe&gt;'));
assert(!closeNode.innerHTML.includes('Past due'));
for (const html of rendered) {
  for (const match of html.matchAll(/(?:onclick|onchange|onsubmit)="([^"]+)"/g)) {
    const action=match[1].replaceAll('&#39;',"'").replaceAll('&quot;','"').replaceAll('&amp;','&');
    for (const [,name] of action.matchAll(/\b((?:ac[A-Z]|accounting[A-Z])[A-Za-z0-9_]*)\s*\(/g)) {
      assert.equal(vm.runInContext(`typeof ${name}`,context),'function',`Missing UI handler ${name}`);
    }
  }
}
assert.equal(vm.runInContext('typeof acReverseCash',context),'function');
console.log('Accounting UI: 17 renderer paths, report filters, drill-down references, filing states and action handlers passed.');

assert.equal(vm.runInContext('acNum(-0)',context),'0.00');
assert.equal(vm.runInContext('acNum(-0.001)',context),'0.00');
assert.equal(vm.runInContext('acNum(-0.01)',context),'-0.01');
vm.runInContext("accountingState.data.accounts.push({code:'1100',name:'Receivables',type:'asset',active:true},{code:'1001',name:'Second bank',type:'asset',active:true});accountingState.data.settings.cashAccounts.push('1001')",context);
assert.equal(vm.runInContext("acBankAccounts().map(a=>a[0]).join(',')",context),'1000,1001');
assert(vm.runInContext("acBankAccountOptions('1001')",context).includes('value="1001" selected'));

// Accounting navigation follows the company application role: admin or owner only.
const financeSource=fs.readFileSync('static/js/finance.js','utf8');
const navigationSource=financeSource.slice(financeSource.indexOf('function setupFinanceNavigation()'),financeSource.indexOf('function financeRoot()'));
for(const [sales,owner,role,expected] of [[false,false,'admin',true],[true,false,'manager',false],[true,true,'owner',true],[false,false,'user',false]]) {
  let inserted=null,legacyRemoved=false;
  const sidebar={querySelector:selector=>selector.includes('nav-section')?{remove:()=>legacyRemoved=true}:null,querySelectorAll:()=>[],insertBefore:section=>inserted=section};
  const navContext=vm.createContext({ensureFinanceSections(){},currentUserHasSalesAccess:()=>sales,isPlatformAdminUser:()=>owner,canCurrentUserManageRoles:()=>owner||role==='admin',currentUser:{role},document:{getElementById:()=>sidebar,createElement:()=>({dataset:{}})}});
  vm.runInContext(navigationSource+';setupFinanceNavigation();',navContext);
  assert.equal((inserted?.innerHTML.match(/data-section="accounting"/g)||[]).length,expected?1:0);
  if(expected)assert(inserted.innerHTML.includes('accounting-beta-badge-nav'));
  if(expected)assert(legacyRemoved);
  if(!sales)assert(!inserted?.innerHTML.includes('data-section="costing"'));
}
console.log('Accounting visual regressions: zero balances, bank account choices and role-aware navigation passed.');

assert.equal(vm.runInContext("acMatchedJournalIds({journalId:'one',journalIds:['one','two']}).join(',')",context),'one,two');
assert(!vm.runInContext("acJournalCanReverse({id:'generated',status:'posted',sourceType:'accounting'})",context));
assert(vm.runInContext("acJournalCanReverse({id:'manual',status:'posted',sourceType:'manual'})",context));
const totalNode={textContent:''}, submitButton={disabled:false};
let selection=[{dataset:{bankAmount:'0.10'}},{dataset:{bankAmount:'0.20'}}];
context.document={querySelector:()=>({querySelectorAll:()=>selection,querySelector:()=>submitButton}),getElementById:()=>totalNode};
vm.runInContext("acState.bankMatch={id:'test',amount:0.3};acBankMatchTotal()",context);
assert(!submitButton.disabled,'A balanced multi-payment match is allowed at cent precision');
selection=[{dataset:{bankAmount:'0.20'}}];
vm.runInContext('acBankMatchTotal()',context);
assert(submitButton.disabled,'An underallocated bank match stays disabled');
assert(totalNode.textContent.includes('Difference SGD 0.10'));
console.log('Accounting workflow controls: grouped payment totals and reversal eligibility passed.');
