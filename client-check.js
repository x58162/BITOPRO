
let state = {};
const $ = id => document.getElementById(id);
const fmt = (n, digits=4) => Number(n||0).toLocaleString('zh-TW',{maximumFractionDigits:digits});
const money = n => fmt(n, 4);
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
async function api(url, method='GET'){const r=await fetch(url,{method,headers:{'Content-Type':'application/json'}});const d=await r.json();if(!r.ok||d.ok===false)throw new Error(JSON.stringify(d.error||d));return d;}
async function controlBot(which){try{const d=await api('/api/'+which,'POST');toast(d.message||'完成');await load();}catch(e){toast(e.message)}}
async function refreshBalance(){try{await api('/api/balance','POST');await load();toast('餘額已更新');}catch(e){toast(e.message)}}
function toast(s){console.log(s);alert(s)}
function render(){
 const s=state.status||{};const dot=$('statusDot');dot.className='dot '+(s.state==='connected'?'green':(['error','needs_config'].includes(s.state)?'red':''));
 $('statusText').textContent=(s.message||'未知')+(state.liveTrading?' · 實盤模式':' · 模擬模式');
 $('startBtn').disabled=!!state.running;$('stopBtn').disabled=!state.running;
 const today=new Date().toLocaleDateString('sv-SE');const d=(state.daily||[]).find(x=>x.date===today)||{};
 $('todaySignals').textContent=fmt(d.signals||0,0);$('todayFills').textContent=fmt(d.fills||0,0);$('todayNet').textContent=money(d.estimatedNet||0);$('totalRecords').textContent=fmt((state.journal||[]).length,0);
 const b=state.balances||[];
$('balances').innerHTML=b.length?`<table><thead><tr><th>幣別</th><th>總額</th><th>可用</th><th>估算台幣價值</th></tr></thead><tbody>${b.map(x=>`<tr><td><b>${esc(x.currency)}</b></td><td>${fmt(x.amount,8)}</td><td>${fmt(x.available,8)}</td><td>${x.twdValue==null?'無報價':'NT$ '+fmt(x.twdValue,2)}</td></tr>`).join('')}</tbody></table>`:'<div class="empty">尚未取得餘額；啟動監控或按「更新餘額」</div>';
 const spreadEntries=Object.entries(state.spreads||{});const groups={};for(const [p,v] of spreadEntries){const quote=p.split('_')[1]?.toUpperCase()||'其他';(groups[quote] ||= []).push([p,v]);}const quoteOrder=['TWD','USDT','USDC','BTC','ETH'];const quotes=[...quoteOrder.filter(q=>groups[q]),...Object.keys(groups).filter(q=>!quoteOrder.includes(q)).sort()];$('spreads').innerHTML=quotes.map(q=>`<div class="quote-group"><h3 class="quote-title">${esc(q)} 報價 · 價差單位：${esc(q)}</h3><div class="pairgrid">${groups[q].map(([p,v])=>`<div class="pair"><div class="pair-head"><strong>${esc(p.toUpperCase())}</strong><button class="remove-pair" onclick="removePair('${esc(p)}')" title="移除此交易對">移除</button></div><input class="spread-input" type="number" min="0" step="any" id="spread-${esc(p)}" value="${esc(v)}" aria-label="${esc(p)} 價差"></div>`).join('')}</div></div>`).join('');
 initOrderPairSelect();
 $('dailyBody').innerHTML=(state.daily||[]).length?(state.daily||[]).map(x=>`<tr><td>${esc(x.date)}</td><td>${x.fills}</td><td>${x.signals}</td><td>${x.submitted}</td><td>${x.failed}</td><td>${money(x.estimatedGross)}</td><td>${money(x.estimatedFees)}</td><td class="${x.estimatedNet>=0?'green':'red'}">${money(x.estimatedNet)}</td></tr>`).join(''):'<tr><td colspan="8" class="empty">尚無資料</td></tr>';
 $('journalBody').innerHTML=(state.journal||[]).length?(state.journal||[]).slice(0,100).map(x=>`<tr><td>${esc(new Date(x.time).toLocaleString())}</td><td>${esc(x.category)}</td><td>${esc((x.pair||'').toUpperCase())}</td><td>${esc(x.action||'')}</td><td>${x.price==null?'—':fmt(x.price,8)}</td><td>${x.amount==null?'—':fmt(x.amount,8)}</td><td>${x.fee==null?'—':fmt(x.fee,8)+' '+esc(x.feeCurrency||'')}</td><td>${x.feeBitoTwdPrice==null?'—': 'NT$ '+fmt(x.feeBitoTwdPrice,8)+'<br><small class="muted">'+esc(x.feePriceTime||'')+'</small>'}</td><td>${x.feeTwdCost==null?'—': 'NT$ '+fmt(x.feeTwdCost,6)}</td><td>${esc(x.result||'')}</td></tr>`).join(''):'<tr><td colspan="10" class="empty">尚無紀錄</td></tr>'; 
 $('events').innerHTML=(state.events||[]).slice(0,60).map(x=>`<div class="event"><time>${esc(new Date(x.time).toLocaleTimeString())}</time><p><span class="tag">${esc(x.type)}</span>${esc(x.message||x.state||x.error||'')}</p></div>`).join('')||'<div class="empty">等待事件…</div>';
}

async function deleteJournalEntry(id){if(!id)return toast('這筆紀錄沒有可用 ID，請重新載入頁面');if(!confirm('確定刪除這一筆本機交易／策略紀錄？此操作無法復原。'))return;try{const r=await fetch('/api/journal/'+encodeURIComponent(id),{method:'DELETE'});const d=await r.json();if(!r.ok||d.ok===false)throw new Error(d.error||'刪除失敗');await load();toast('紀錄已刪除');}catch(e){toast('刪除失敗：'+e.message)}}
async function clearJournal(){if(!confirm('確定刪除「最近交易／策略紀錄」中的全部本機紀錄？此操作無法復原，但不會撤銷交易所成交或改變帳戶資產。'))return;try{const r=await fetch('/api/journal',{method:'DELETE'});const d=await r.json();if(!r.ok||d.ok===false)throw new Error(d.error||'刪除失敗');await load();toast('全部紀錄已刪除');}catch(e){toast('刪除失敗：'+e.message)}}

async function saveSpreads(){try{const next={};for(const [p] of Object.entries(state.spreads||{})){const el=$('spread-'+p);if(!el||el.value.trim()===''||!Number.isFinite(Number(el.value))||Number(el.value)<0){throw new Error(p.toUpperCase()+' 價差必須是大於或等於 0 的數字');}next[p]=Number(el.value);}const d=await fetch('/api/spreads',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(next)});const result=await d.json();if(!d.ok||result.ok===false)throw new Error(result.error||'儲存失敗');state.spreads=result.spreads;render();$('spreadStatus').textContent='已儲存 '+new Date().toLocaleTimeString();toast(result.message);}catch(e){$('spreadStatus').textContent='儲存失敗：'+e.message;}}
async function addPair(){try{const pair=$('newPair').value.trim();const spread=$('newSpread').value.trim();if(!pair)throw new Error('請輸入交易對，例如 ada_twd 或 eth_usdt');if(spread===''||!Number.isFinite(Number(spread))||Number(spread)<0)throw new Error('請輸入有效的初始價差');const d=await fetch('/api/pairs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'add',pair,spread:Number(spread)})});const result=await d.json();if(!d.ok||result.ok===false)throw new Error(result.error||'新增失敗');state.pairs=result.pairs;state.spreads=result.spreads;$('newPair').value='';$('newSpread').value='0';render();$('spreadStatus').textContent=result.message;}catch(e){toast(e.message)}}
async function removePair(pair){if(!confirm('確定移除 '+pair.toUpperCase()+'？這只會移除管理台設定，不會撤銷交易所已有掛單。'))return;try{const d=await fetch('/api/pairs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'remove',pair})});const result=await d.json();if(!d.ok||result.ok===false)throw new Error(result.error||'移除失敗');state.pairs=result.pairs;state.spreads=result.spreads;render();$('spreadStatus').textContent=result.message;}catch(e){toast(e.message)}}
function resetSpreadInputs(){render();$('spreadStatus').textContent='已重新載入伺服器目前設定。'}
async function load(){try{state=await api('/api/state');render()}catch(e){$('statusText').textContent='無法連線至後端：'+e.message}}
function connectLive(){
  const scheme=location.protocol==='https:'?'wss:':'ws:';
  const live=new WebSocket(`${scheme}//${location.host}/live`);
  live.addEventListener('message',ev=>{
    try{const msg=JSON.parse(ev.data);
      if(msg.kind==='snapshot'&&msg.state){state={...state,...msg.state};render();}
      else if(msg.kind==='event'&&msg.item){
        const item=msg.item;state.events=[item,...(state.events||[])].slice(0,100);
        if(item.type==='journal'||item.type==='balances'||item.type==='status'){load();return;}
        render();
      }
    }catch(e){console.warn('即時更新解析失敗',e)}
  });
  live.addEventListener('close',()=>setTimeout(connectLive,3000));
}

function initOrderPairSelect(){
  const pairs=Object.keys(state.spreads||{});
  const sel=$('orderPair');
  if(sel){const old=sel.value;sel.innerHTML=pairs.map(p=>`<option value="${esc(p)}">${esc(p.toUpperCase())}</option>`).join('');if(pairs.includes(old))sel.value=old;}
  const filter=$('orderFilterPair');
  if(filter){const oldFilter=filter.value;filter.innerHTML='<option value="">全部交易對</option>'+pairs.map(p=>`<option value="${esc(p)}">${esc(p.toUpperCase())}</option>`).join('');if(oldFilter===''||pairs.includes(oldFilter))filter.value=oldFilter;}
}
async function loadExchangeOrders(){
  const body=$('exchangeOrdersBody');const statusEl=$('orderStatus');
  body.innerHTML='<tr><td colspan="9" class="empty">正在向 BitoPro 查詢真實掛單…</td></tr>';
  try{
    const pair=$('orderFilterPair')?.value||'';
    const d=await api('/api/orders/open'+(pair?'?pair='+encodeURIComponent(pair):''));
    const raw=d.orders??d.data??[];
    const orders=Array.isArray(raw)?raw:(Array.isArray(raw.orders)?raw.orders:(Array.isArray(raw.data)?raw.data:[]));
    body.innerHTML=orders.length?orders.map(o=>{const id=o.id||o.orderId||'';const pairName=String(o.pair||pair).toLowerCase();return `<tr><td>${esc(new Date(Number(o.updatedTimestamp||o.createdTimestamp||Date.now())).toLocaleString())}</td><td>${esc(id)}</td><td>${esc(pairName.toUpperCase())}</td><td>${esc(o.action||'')}</td><td>${fmt(o.price,10)}</td><td>${fmt(o.originalAmount,10)}</td><td>${fmt(o.executedAmount,10)}</td><td>${fmt(o.remainingAmount,10)}</td><td><div class="order-actions"><button onclick="editExchangeOrder('${esc(pairName)}','${esc(id)}','${esc(o.action||'BUY')}',${Number(o.price)||0},${Number(o.remainingAmount||o.originalAmount)||0})">修改</button><button class="stop" onclick="cancelExchangeOrder('${esc(pairName)}','${esc(id)}')">刪除／撤單</button></div></td></tr>`}).join(''):'<tr><td colspan="9" class="empty">交易所目前沒有符合此交易對的掛單</td></tr>';
    statusEl.textContent=`已從 BitoPro 讀取 ${orders.length} 筆掛單（${pair?pair.toUpperCase():'全部交易對'}，${new Date().toLocaleTimeString()}）。列表來自交易所，不是本機草稿。`;
  }catch(e){body.innerHTML='<tr><td colspan="9" class="empty">無法取得交易所掛單</td></tr>';statusEl.textContent='讀取失敗：'+e.message;}
}
async function submitExchangeOrder(ev){
  ev.preventDefault();const pair=$('orderPair').value;const action=$('orderAction').value;const price=Number($('orderPrice').value);const amount=Number($('orderAmount').value);const timeInForce=$('orderTif').value;
  if(!pair) return toast('請先在策略價差設定中加入交易對。');
  const total=price*amount;
  if(!confirm(`即將向 BitoPro 建立真實限價委託：\n\n交易對：${pair.toUpperCase()}\n方向：${action}\n價格：${price}\n數量：${amount}\n名目金額：約 ${fmt(total,8)}\n條件：${timeInForce}\n\n此操作會影響真實帳戶。確定送出嗎？`))return;
  $('orderStatus').textContent='已送出請求，等待交易所回應…';
  try{const d=await fetch('/api/orders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pair,action,price,amount,timeInForce})});const r=await d.json();if(!d.ok||r.ok===false)throw new Error(typeof r.error==='string'?r.error:JSON.stringify(r.error||r));$('orderStatus').textContent=r.message||'交易所已回應';toast(r.message||'交易所已回應建立委託');$('orderPrice').value='';$('orderAmount').value='';await loadExchangeOrders();await load();}catch(e){$('orderStatus').textContent='建立失敗：'+e.message;toast('建立失敗：'+e.message)}
}
async function cancelExchangeOrder(pair,id){if(!confirm(`確定向 BitoPro 撤銷真實掛單？\n\n${pair.toUpperCase()}\n訂單 ID：${id}\n\n若已成交或正在成交，可能無法撤銷。`))return;try{const d=await fetch(`/api/orders/${encodeURIComponent(pair)}/${encodeURIComponent(id)}`,{method:'DELETE',headers:{'Content-Type':'application/json'}});const r=await d.json();if(!d.ok||r.ok===false)throw new Error(typeof r.error==='string'?r.error:JSON.stringify(r.error||r));toast(r.message||'撤單請求已回應');await loadExchangeOrders();await load();}catch(e){toast('撤單失敗：'+e.message)}}
async function editExchangeOrder(pair,id,action,price,amount){
  const nextAction=(prompt('修改方向：輸入 BUY 或 SELL',action)||'').trim().toUpperCase();if(!nextAction)return;if(!['BUY','SELL'].includes(nextAction))return toast('方向只能是 BUY 或 SELL');
  const nextPrice=Number(prompt('輸入新的價格',String(price)));if(!Number.isFinite(nextPrice)||nextPrice<=0)return toast('價格無效');
  const nextAmount=Number(prompt('輸入新的數量（預設為剩餘數量）',String(amount)));if(!Number.isFinite(nextAmount)||nextAmount<=0)return toast('數量無效');
  const timeInForce=$('orderTif').value||'POST_ONLY';
  if(!confirm(`修改真實掛單將先撤銷舊單，再建立新單。若新單建立失敗，舊單仍會維持已撤銷狀態。\n\n${pair.toUpperCase()} #${id}\n新方向：${nextAction}\n新價格：${nextPrice}\n新數量：${nextAmount}\n\n確定繼續？`))return;
  try{const d=await fetch(`/api/orders/${encodeURIComponent(pair)}/${encodeURIComponent(id)}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:nextAction,price:nextPrice,amount:nextAmount,timeInForce})});const r=await d.json();if(!d.ok||r.ok===false)throw new Error(typeof r.error==='string'?r.error:JSON.stringify(r.error||r));toast(r.message||'修改完成');await loadExchangeOrders();await load();}catch(e){toast('修改失敗：'+e.message)}
}
load();connectLive();
