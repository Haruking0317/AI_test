(function(){
  const apiBaseEl = document.getElementById('apiBase');
  const messagesEl = document.getElementById('messages');
  const inputForm = document.getElementById('inputForm');
  const inputEl = document.getElementById('input');
  const sendBtn = document.getElementById('sendBtn');

  const DEFAULT_API_BASE = 'http://127.0.0.1:1234';
  const DEFAULT_MODEL = 'gpt-oss-20b';
  const DEFAULT_SYSTEM_PROMPT = '';

  // 会話メッセージ（{role: 'system'|'user'|'assistant', content: '...' } の配列）
  const chatMessages = [];

  function appendBubble(text, who='ai', extraClass=''){
    const div = document.createElement('div');
    div.className = `bubble ${who} ${extraClass}`.trim();
    div.textContent = text;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  // HTML を直接挿入するバブル（すでに安全化済みのときに使う）
  function appendHTMLBubble(html, who='ai'){
    const div = document.createElement('div');
    div.className = `bubble ${who}`;
    div.innerHTML = html;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  // Markdown を安全にレンダリングしてバブルに追加する
  function appendMarkdownBubble(markdown, who='ai'){
    try{
      const raw = (typeof marked !== 'undefined') ? marked.parse(markdown || '') : (markdown || '');
      const safe = (typeof DOMPurify !== 'undefined') ? DOMPurify.sanitize(raw) : raw;
      return appendHTMLBubble(safe, who);
    }catch(e){
      return appendBubble(markdown, who);
    }
  }

  // 「回答を生成中…」のアニメーション付きインジケータを作成
  function createTypingBubble(who='ai'){
    const div = document.createElement('div');
    div.className = `bubble ${who} typing`;
    div.textContent = '回答を生成中';
    let cnt = 0;
    const iv = setInterval(()=>{
      cnt = (cnt + 1) % 4; // 0..3
      div.textContent = '回答を生成中' + '.'.repeat(cnt);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }, 400);
    // 保持しておいて後でクリアできるようにする
    div.__dotsInterval = iv;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  // 上で作った typing バブルを停止して削除する
  function stopTypingBubble(el){
    if(!el) return;
    try{ if(el.__dotsInterval) clearInterval(el.__dotsInterval); }catch(e){}
    try{ el.remove(); }catch(e){}
  }

  // Wikipedia からサマリを取得するヘルパー
  async function fetchWikiSummary(query){
    if(!query || !query.trim()) return null;
    try{
      const s = encodeURIComponent(query.trim());
      // opensearch で候補を1件取得（CORS のため origin=* を付与）
      const searchUrl = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${s}&limit=1&namespace=0&format=json&origin=*`;
      const r1 = await fetch(searchUrl);
      if(!r1.ok) return null;
      const d1 = await r1.json();
      if(!d1 || !Array.isArray(d1) || !d1[1] || !d1[1].length) return null;
      const title = d1[1][0];
      const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
      const r2 = await fetch(summaryUrl);
      if(!r2.ok) return null;
      const j = await r2.json();
      return {
        title: j.title || title,
        extract: j.extract || '',
        url: (j.content_urls && j.content_urls.desktop && j.content_urls.desktop.page) ? j.content_urls.desktop.page : (`https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`)
      };
    }catch(e){
      return null;
    }
  }

  // Wikipedia サマリを安全に表示する HTML を作る
  function renderWikiBox(obj){
    if(!obj) return '';
    const title = obj.title || '';
    const extract = obj.extract || '';
    const url = obj.url || '#';
    const raw = `<div class="wiki-helper"><strong>補助情報 — Wikipedia: ${title}</strong><p>${extract}</p><p><a href="${url}" target="_blank" rel="noopener">続きを読む</a></p></div>`;
    return (typeof DOMPurify !== 'undefined') ? DOMPurify.sanitize(raw) : raw;
  }

  async function sendMessage(msg){
    const apiBase = (apiBaseEl && apiBaseEl.value) ? apiBaseEl.value.trim() : DEFAULT_API_BASE;
    const modelEl = document.getElementById('model');
    const systemEl = document.getElementById('systemPrompt');

    if(!apiBase){
      appendBubble('API Base URLを設定してください。', 'ai', 'error');
      return;
    }

    // ユーザーメッセージを画面に表示
    appendBubble(msg, 'user');
    inputEl.value = '';
    sendBtn.disabled = true;

    // 履歴にユーザーメッセージを追加
    chatMessages.push({role: 'user', content: msg});

    // 補助情報: Wikipedia のサマリを取得して表示（存在すれば）
    try{
      const wiki = await fetchWikiSummary(msg);
      if(wiki && wiki.extract){
        const wikiHtml = renderWikiBox(wiki);
        appendHTMLBubble(wikiHtml, 'ai');
      }
    }catch(e){
      // 補助情報が取れなくても処理は継続
      console.debug('wiki fetch failed', e);
    }

    // システムプロンプトが指定されていれば先頭に入れる
    const systemPrompt = (systemEl && systemEl.value && systemEl.value.trim()) ? systemEl.value.trim() : DEFAULT_SYSTEM_PROMPT;
    if(systemPrompt){
      // if chatMessages doesn't already have system at index 0, unshift it
      if(!chatMessages.length || chatMessages[0].role !== 'system'){
        chatMessages.unshift({role:'system', content: systemPrompt});
      } else {
        chatMessages[0].content = systemPrompt;
      }
    }

    // 打ち込み中インジケータ（アニメーション付き）
    const typing = createTypingBubble('ai');

    try{
      const model = (modelEl && modelEl.value) ? modelEl.value.trim() : DEFAULT_MODEL;
      const url = apiBase.replace(/\/$/, '') + '/v1/chat/completions';

      // サーバ互換のために複数のペイロード候補を用意
      const candidateMessages = chatMessages.map(m => ({ role: m.role, content: m.content }));
      const payloads = [];
      const base = {};
      if(model) base.model = model;
      // Candidate 1: standard OpenAI-like {model, messages:[{role,content:string}]}
      payloads.push(Object.assign({}, base, { messages: candidateMessages }));
      // Candidate 2: messages with content as array of text blocks (some OSS servers expect this)
      payloads.push(Object.assign({}, base, { messages: chatMessages.map(m=>({ role: m.role, content: [{ type: 'text', text: m.content }] })) }));
      // Candidate 3: messages with content as object {type,text}
      payloads.push(Object.assign({}, base, { messages: chatMessages.map(m=>({ role: m.role, content: { type: 'text', text: m.content } })) }));

      let res = null;
      let bodyText = '';
      let usedPayload = null;

      for(const payload of payloads){
        usedPayload = payload;
        try{
          console.debug('POST', url, payload);
          res = await fetch(url, {
            method: 'POST',
            headers: {'Content-Type':'application/json','Accept':'application/json'},
            body: JSON.stringify(payload)
          });
        }catch(e){
          res = null;
        }
        if(!res) continue;
        bodyText = await res.text();
        // if server responded 404 to OPTIONS or similar, skip; if server says missing messages, try next
        if(res.ok) break;
        // if error message explicitly complains about missing 'messages', try next payload
        if(bodyText && /messages'.*required|messages.*required/i.test(bodyText)){
          continue;
        }
        // otherwise break and report this error
        break;
      }

      // インジケータを削除
      stopTypingBubble(typing);

      if(!res){
        appendBubble('サーバへ接続できませんでした（ネットワークエラー）。', 'ai', 'error');
        return;
      }

      if(!res.ok){
        appendBubble(`エラー: ${res.status} ${res.statusText}\n${bodyText}\n(Payload used: ${JSON.stringify(usedPayload)})`, 'ai', 'error');
        return;
      }

      // レスポンスを解析
      let data;
      try{ data = JSON.parse(bodyText); }catch(e){ data = null; }

      let reply = null;
      if(data){
        if(data.choices && Array.isArray(data.choices) && data.choices.length){
          const ch = data.choices[0];
          if(ch.message && ch.message.content) reply = (typeof ch.message.content === 'string') ? ch.message.content : (ch.message.content.text || JSON.stringify(ch.message.content));
          else if(ch.text) reply = ch.text;
          else if(ch.delta && ch.delta.content) reply = ch.delta.content;
        }
        if(!reply && data.output && Array.isArray(data.output) && data.output.length){
          const o = data.output[0];
          if(typeof o === 'string') reply = o;
          else if(o.content) reply = (typeof o.content === 'string') ? o.content : JSON.stringify(o.content);
        }
        if(!reply && data.reply) reply = data.reply;
        if(!reply && data.response) reply = data.response;
        if(!reply) reply = JSON.stringify(data, null, 2);
      }else{
        reply = bodyText;
      }

      // アシスタントの応答を履歴に追加
      chatMessages.push({role:'assistant', content: reply});
      // render assistant reply as Markdown
      appendMarkdownBubble(reply, 'ai');

    }catch(err){
      stopTypingBubble(typing);
      appendBubble('エラー: ' + err.message, 'ai', 'error');
    }finally{
      sendBtn.disabled = false;
      inputEl.focus();
    }
  }

  // フォーム送信（送信ボタン押下など）
  inputForm.addEventListener('submit', (e)=>{
    e.preventDefault();
    const v = inputEl.value.trim();
    if(!v) return;
    sendMessage(v);
  });

  // キーボードのショートカット: Shift+Enter で送信する
  inputEl.addEventListener('keydown', (e)=>{
    if(e.key === 'Enter' && e.shiftKey){
      e.preventDefault();
      const v = inputEl.value.trim();
      if(!v) return;
      sendMessage(v);
    }
  });

  // initial prompt
  appendBubble('何か聞きたいことがありますか？', 'ai');

  // clear history control
  const clearBtn = document.getElementById('clearHistory');
  if(clearBtn){
    clearBtn.addEventListener('click', ()=>{
      chatMessages.length = 0;
      messagesEl.innerHTML = '';
      appendHTMLBubble('<strong>会話履歴をクリアしました。</strong>', 'ai');
    });
  }
})();