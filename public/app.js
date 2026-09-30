// Panel Cukierni A.Keller – bez frameworków, żeby łatwo było go zmieniać.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const fmt = (iso) =>
  iso
    ? new Date(iso).toLocaleString('pl-PL', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '—';

// ISO → wartość dla <input type="datetime-local"> w czasie lokalnym przeglądarki
const toLocalInput = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const fromLocalInput = (v) => (v ? new Date(v).toISOString() : '');

async function api(path, options = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Błąd ${res.status}`);
  return data;
}

function toast(text, isError = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = text;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), isError ? 7000 : 4000);
}

// Wspólny handler dla przycisków akcji: blokada, komunikat, odświeżenie.
async function action(btn, fn, okText) {
  btn.disabled = true;
  try {
    const r = await fn();
    if (r?.sms && !r.sms.ok) toast(`Status zmieniony, ale SMS nie wyszedł: ${r.sms.error}`, true);
    else if (okText) toast(okText);
    await refresh();
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
  }
}

// ───────────── Zakładki ─────────────
let currentTab = location.hash.slice(1) || 'zapytania';
function showTab(name) {
  currentTab = name;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
  history.replaceState(null, '', '#' + name);
  refresh();
}
$$('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

// ───────────── Zapytania ─────────────
let inqStatus = 'do_mnie';
$$('#inq-filter .chip').forEach((c) =>
  c.addEventListener('click', () => {
    inqStatus = c.dataset.status;
    $$('#inq-filter .chip').forEach((x) => x.classList.toggle('active', x === c));
    renderInquiries();
  }),
);

const SOURCE_TAG = { facebook: 'fb', instagram: 'ig' };
const CATEGORY = { pytanie: 'pytanie', zamowienie: 'zamówienie', reklamacja: 'reklamacja', inne: 'inne' };
const INQ_STATUS = { nowe: 'szkic AI', do_mnie: 'wymaga Ciebie', odpowiedziane: 'odpowiedziane', zamkniete: 'zamknięte' };

async function renderInquiries() {
  const rows = await api('/inquiries' + (inqStatus ? `?status=${inqStatus}` : ''));
  const box = $('#inquiries');
  if (!rows.length) {
    box.innerHTML = `<p class="empty">Brak zapytań w tym widoku.</p>`;
    return;
  }
  box.innerHTML = rows
    .map((q) => {
      const open = q.status === 'do_mnie' || q.status === 'nowe';
      const autoChannel = q.source === 'facebook' || q.source === 'instagram';
      return `
      <article class="card ${q.status === 'do_mnie' ? 'urgent' : ''}" data-id="${q.id}">
        <div class="card-head">
          <strong>${esc(q.sender_name || 'Klient')} ${q.contact ? `<span class="meta">· ${esc(q.contact)}</span>` : ''}</strong>
          <span class="meta">#${q.id} · ${fmt(q.created_at)}</span>
        </div>
        <div>
          <span class="tag ${SOURCE_TAG[q.source] || ''}">${esc(q.source)}</span>
          ${q.ai_category ? `<span class="tag">${esc(CATEGORY[q.ai_category] || q.ai_category)}</span>` : ''}
          <span class="tag ${q.status === 'do_mnie' ? 'bad' : q.status === 'odpowiedziane' ? 'ok' : ''}">${INQ_STATUS[q.status] || q.status}</span>
          ${q.order_id ? `<span class="tag ok">zamówienie #${q.order_id}</span>` : ''}
        </div>
        <div class="msg">${esc(q.message)}</div>
        ${q.ai_reason ? `<div class="ai"><b>AI:</b> ${esc(q.ai_reason)}</div>` : ''}
        ${
          open
            ? `<textarea rows="3" class="reply" placeholder="Odpowiedź…">${esc(q.ai_reply || '')}</textarea>
               <div class="actions">
                 <button class="btn" data-act="reply">${autoChannel ? 'Wyślij odpowiedź' : 'Zapisz jako wysłaną'}</button>
                 ${q.contact && /^[\d +()-]{9,}$/.test(q.contact) ? `<a class="btn ghost" href="tel:${esc(q.contact)}">Zadzwoń</a>` : ''}
                 <button class="btn ghost" data-act="close">Zamknij bez odpowiedzi</button>
               </div>`
            : q.final_reply
              ? `<div class="ai"><b>Odpowiedź:</b> ${esc(q.final_reply)} <span class="meta">(${fmt(q.replied_at)})</span></div>`
              : ''
        }
      </article>`;
    })
    .join('');

  $$('#inquiries [data-act]').forEach((btn) => {
    const card = btn.closest('.card');
    const id = card.dataset.id;
    btn.addEventListener('click', () => {
      if (btn.dataset.act === 'reply') {
        const text = $('.reply', card).value;
        action(btn, () => api(`/inquiries/${id}/reply`, { method: 'POST', body: { text } }), 'Odpowiedź zapisana');
      } else {
        action(btn, () => api(`/inquiries/${id}/close`, { method: 'POST' }), 'Zamknięto');
      }
    });
  });
}

// ───────────── Zamówienia ─────────────
function orderDetails(o) {
  const rows = [
    ['Produkt', o.product],
    ['Szczegóły', o.details],
    ['Termin', o.due_at ? fmt(o.due_at) : ''],
    ['Sposób', o.fulfillment === 'dostawa' ? 'Dostawa' : 'Odbiór osobisty'],
    ['Adres', o.fulfillment === 'dostawa' ? o.address : ''],
    ['Telefon', o.phone ? `<a href="tel:${esc(o.phone)}">${esc(o.phone)}</a>` : '<span class="tag bad">brak</span>'],
    ['Notatki', o.notes],
  ].filter(([, v]) => v);
  return `<dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${k === 'Telefon' ? v : esc(v)}</dd>`).join('')}</dl>`;
}

function orderCard(o, actionsHtml, extraClass = '') {
  return `
    <article class="card ${extraClass}" data-id="${o.id}">
      <div class="card-head">
        <strong>#${o.id} ${esc(o.customer_name || 'Klient')}</strong>
        <span class="meta">${esc(o.source || '')}</span>
      </div>
      ${o.callback_reason ? `<div class="ai"><b>Do doprecyzowania:</b> ${esc(o.callback_reason)}</div>` : ''}
      ${orderDetails(o)}
      <div class="actions">${actionsHtml}<button class="btn ghost" data-act="edit">Edytuj</button></div>
    </article>`;
}

const ORDER_ACTIONS = {
  approve: (id) => api(`/orders/${id}/approve`, { method: 'POST' }),
  callback: (id) => {
    const reason = prompt('Co trzeba doprecyzować z klientem?');
    if (reason === null) return Promise.resolve(null);
    return api(`/orders/${id}/callback`, { method: 'POST', body: { reason } });
  },
  cancel: (id) => (confirm('Anulować zamówienie?') ? api(`/orders/${id}/cancel`, { method: 'POST' }) : Promise.resolve(null)),
  ready: (id) => api(`/orders/${id}/ready`, { method: 'POST' }),
  'picked-up': (id) => api(`/orders/${id}/picked-up`, { method: 'POST' }),
  delivered: (id) => api(`/orders/${id}/delivered`, { method: 'POST' }),
  delivery: (id, card) => {
    const eta = $('.eta', card)?.value;
    if (!eta) return Promise.reject(new Error('Wybierz termin dostawy'));
    return api(`/orders/${id}/delivery`, { method: 'POST', body: { eta: fromLocalInput(eta) } });
  },
};
const ORDER_OK = {
  approve: 'Wysłano do realizacji',
  callback: 'Przeniesiono do oddzwonienia',
  cancel: 'Anulowano',
  ready: 'Oznaczono jako gotowe – SMS wysłany',
  'picked-up': 'Odebrane',
  delivered: 'Dostarczone – SMS wysłany',
  delivery: 'Termin dostawy wysłany SMS-em',
};

function bindOrderActions(root, ordersById) {
  $$('[data-act]', root).forEach((btn) => {
    const card = btn.closest('.card');
    const id = card.dataset.id;
    const act = btn.dataset.act;
    btn.addEventListener('click', () => {
      if (act === 'edit') return openOrderDialog(ordersById[id]);
      action(btn, () => ORDER_ACTIONS[act](id, card), ORDER_OK[act]);
    });
  });
}

const fill = (sel, items, render) => {
  $(sel).innerHTML = items.length ? items.map(render).join('') : `<p class="empty">Pusto.</p>`;
};
const byId = (list) => Object.fromEntries(list.map((o) => [o.id, o]));

async function renderOrders() {
  const list = await api('/orders?status=nowe,do_oddzwonienia');
  fill('#orders-new', list.filter((o) => o.status === 'nowe'), (o) =>
    orderCard(
      o,
      `<button class="btn ok" data-act="approve">Do realizacji</button>
       <button class="btn warn" data-act="callback">Wymaga doprecyzowania</button>`,
    ),
  );
  fill('#orders-callback', list.filter((o) => o.status === 'do_oddzwonienia'), (o) =>
    orderCard(
      o,
      `${o.phone ? `<a class="btn warn" href="tel:${esc(o.phone)}">Zadzwoń</a>` : ''}
       <button class="btn ok" data-act="approve">Ustalone – do realizacji</button>
       <button class="btn ghost" data-act="cancel">Anuluj</button>`,
      'warn',
    ),
  );
  bindOrderActions($('#tab-zamowienia'), byId(list));
}

// ───────────── Realizacja ─────────────
let reminderHours = 12;

async function renderRealizacja() {
  const list = await api('/orders?status=w_realizacji,gotowe,w_dostawie');
  const done = await api('/orders?status=dostarczone,odebrane');

  fill('#r-production', list.filter((o) => o.status === 'w_realizacji'), (o) =>
    orderCard(o, `<button class="btn ok" data-act="ready">Gotowe → SMS</button>`),
  );

  fill('#r-pickup', list.filter((o) => o.status === 'gotowe' && o.fulfillment === 'odbior'), (o) => {
    const remindAt = new Date(new Date(o.ready_at).getTime() + reminderHours * 3600_000);
    const info = o.reminder_sent_at
      ? `<span class="tag bad">przypomnienie wysłane ${fmt(o.reminder_sent_at)}</span>`
      : `<span class="meta">Gotowe od ${fmt(o.ready_at)} · przypomnienie ${fmt(remindAt.toISOString())}</span>`;
    return orderCard(o, `${info}<button class="btn ok" data-act="picked-up">Odebrane</button>`, o.reminder_sent_at ? 'urgent' : '');
  });

  fill('#r-delivery', list.filter((o) => o.fulfillment === 'dostawa' && o.status !== 'w_realizacji'), (o) => {
    if (o.status === 'gotowe') {
      return orderCard(
        o,
        `<input type="datetime-local" class="eta" value="${toLocalInput(o.due_at)}" />
         <button class="btn" data-act="delivery">Wyślij termin dostawy</button>`,
        'warn',
      );
    }
    return orderCard(
      o,
      `<span class="meta">Dostawa: <b>${fmt(o.delivery_eta)}</b></span>
       <button class="btn ok" data-act="delivered">Dostarczono → SMS</button>
       <details><summary class="meta">zmień termin</summary>
         <input type="datetime-local" class="eta" value="${toLocalInput(o.delivery_eta)}" />
         <button class="btn ghost" data-act="delivery">Wyślij nowy termin</button>
       </details>`,
    );
  });

  const recent = done.sort((a, b) => b.id - a.id).slice(0, 30);
  fill('#r-done', recent, (o) =>
    `<article class="card"><div class="card-head"><strong>#${o.id} ${esc(o.customer_name || '')}</strong>
     <span class="tag ok">${o.status}</span></div><div class="meta">${esc(o.product || '')} · ${fmt(o.delivered_at || o.picked_up_at)}</div></article>`,
  );

  bindOrderActions($('#tab-realizacja'), byId(list));
}

// ───────────── SMS ─────────────
const SMS_KIND = {
  gotowe: 'gotowe (dostawa)',
  gotowe_odbior: 'gotowe do odbioru',
  termin_dostawy: 'termin dostawy',
  dostarczone: 'dostarczone',
  przypomnienie: 'przypomnienie',
  wlasciciel: 'do właściciela',
};
async function renderSms() {
  const rows = await api('/sms');
  $('#sms-log').innerHTML =
    rows
      .map(
        (s) => `<tr>
        <td>${fmt(s.created_at)}</td><td>${s.order_id ? '#' + s.order_id : ''}</td>
        <td>${SMS_KIND[s.kind] || esc(s.kind)}</td><td>${esc(s.phone)}</td><td>${esc(s.body)}</td>
        <td><span class="tag ${s.status === 'blad' ? 'bad' : 'ok'}">${esc(s.status)}</span>${s.error ? ` ${esc(s.error)}` : ''}</td>
      </tr>`,
      )
      .join('') || `<tr><td colspan="6" class="empty">Jeszcze nie wysłano żadnego SMS-a.</td></tr>`;
}

// ───────────── Formularze ─────────────
const orderDialog = $('#order-dialog');
const orderForm = $('#order-form');
let editingId = null;

function openOrderDialog(order = null) {
  editingId = order?.id ?? null;
  $('#order-dialog-title').textContent = order ? `Zamówienie #${order.id}` : 'Nowe zamówienie';
  orderForm.reset();
  if (order) {
    for (const el of orderForm.elements) {
      if (!el.name) continue;
      el.value = el.name === 'due_at' ? toLocalInput(order.due_at) : (order[el.name] ?? '');
    }
  }
  toggleAddress();
  orderDialog.showModal();
}
const toggleAddress = () => {
  $('.addr', orderForm).style.display = orderForm.fulfillment.value === 'dostawa' ? '' : 'none';
};
orderForm.fulfillment.addEventListener('change', toggleAddress);
$('#order-cancel').addEventListener('click', () => orderDialog.close());
$('#btn-new-order').addEventListener('click', () => openOrderDialog());

orderForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(orderForm));
  body.due_at = fromLocalInput(body.due_at);
  try {
    if (editingId) await api(`/orders/${editingId}`, { method: 'PATCH', body });
    else await api('/orders', { method: 'POST', body });
    orderDialog.close();
    toast('Zapisano');
    refresh();
  } catch (err) {
    toast(err.message, true);
  }
});

const inquiryDialog = $('#inquiry-dialog');
const inquiryForm = $('#inquiry-form');
$('#btn-new-inquiry').addEventListener('click', () => {
  inquiryForm.reset();
  inquiryDialog.showModal();
});
$('#inquiry-cancel').addEventListener('click', () => inquiryDialog.close());
inquiryForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('button[type=submit]', inquiryForm);
  btn.disabled = true;
  try {
    await api('/inquiries', { method: 'POST', body: Object.fromEntries(new FormData(inquiryForm)) });
    inquiryDialog.close();
    toast('Zapytanie dodane i przeanalizowane');
    refresh();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

// ───────────── Odświeżanie i powiadomienia ─────────────
async function refreshBadges() {
  const s = await api('/summary');
  $('#b-zapytania').textContent = s.zapytaniaDoMnie || '';
  $('#b-zamowienia').textContent = s.zamowieniaNowe + s.doOddzwonienia || '';
  $('#b-realizacja').textContent = s.wRealizacji || '';
  document.title = (s.zapytaniaDoMnie ? `(${s.zapytaniaDoMnie}) ` : '') + 'Cukiernia – panel';
}

async function refresh() {
  try {
    await refreshBadges();
    await { zapytania: renderInquiries, zamowienia: renderOrders, realizacja: renderRealizacja, sms: renderSms }[currentTab]();
  } catch (e) {
    toast(e.message, true);
  }
}

const EVENT_TEXT = {
  nowe_zapytanie: (e) => `Nowe zapytanie #${e.inquiryId}`,
  zapytanie_do_mnie: (e) => `Zapytanie #${e.inquiryId} wymaga Twojej odpowiedzi`,
  nowe_zamowienie: (e) => `Nowe zamówienie #${e.orderId}`,
  zamowienie_do_oddzwonienia: (e) => `Zamówienie #${e.orderId} – do oddzwonienia`,
  przypomnienie_wyslane: (e) => `Wysłano przypomnienie o odbiorze (#${e.orderId})`,
};

function systemNotify(text) {
  if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
    new Notification('Cukiernia', { body: text });
  }
}

function connectEvents() {
  const es = new EventSource('/api/events');
  let timer;
  es.onmessage = (msg) => {
    const e = JSON.parse(msg.data);
    const text = EVENT_TEXT[e.type]?.(e);
    if (text) {
      toast(text);
      systemNotify(text);
    }
    clearTimeout(timer);
    timer = setTimeout(refresh, 300);
  };
}

async function init() {
  const cfg = await api('/config');
  reminderHours = cfg.pickupReminderHours;
  $('#bakery-name').textContent = cfg.bakeryName;
  $('#status-bar').innerHTML = [
    cfg.aiEnabled ? `AI: włączone${cfg.aiAutoReply ? ' (auto-odpowiedzi)' : ''}` : 'AI: wyłączone',
    `SMS: ${cfg.smsProvider}`,
    cfg.metaConnected ? 'Meta: połączone' : 'Meta: niepołączone',
  ]
    .map((t) => `<span>${esc(t)}</span>`)
    .join('');
  if ('Notification' in window && Notification.permission === 'default') {
    document.addEventListener('click', () => Notification.requestPermission(), { once: true });
  }
  connectEvents();
  showTab(currentTab);
}

init().catch((e) => toast(e.message, true));
