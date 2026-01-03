(function(){
  const apiBaseEl = document.getElementById('apiBase');
  const messagesEl = document.getElementById('messages');
  const inputForm = document.getElementById('inputForm');
  const inputEl = document.getElementById('input');
  const sendBtn = document.getElementById('sendBtn');

  const DEFAULT_API_BASE = 'http://127.0.0.1:1234';
  const DEFAULT_MODEL = 'gpt-oss-20b';
  const DEFAULT_SYSTEM_PROMPT = '';

  // conversation messages stored as {role: 'system'|'user'|'assistant', content: '...'}
  const chatMessages = [];

  function appendBubble(text, who='ai', extraClass=''){
    const div = document.createElement('div');
    div.className = `bubble ${who} ${extraClass}`.trim();
    div.textContent = text;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  function appendHTMLBubble(html, who='ai'){
    const div = document.createElement('div');
    div.className = `bubble ${who}`;
    div.innerHTML = html;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  function appendMarkdownBubble(markdown, who='ai'){
    try{
      const raw = (typeof marked !== 'undefined') ? marked.parse(markdown || '') : (markdown || '');
      const safe = (typeof DOMPurify !== 'undefined') ? DOMPurify.sanitize(raw) : raw;
      return appendHTMLBubble(safe, who);
    }catch(e){
      return appendBubble(markdown, who);
    }
  }

  async function sendMessage(msg){
    const apiBase = (apiBaseEl && apiBaseEl.value) ? apiBaseEl.value.trim() : DEFAULT_API_BASE;
    const modelEl = document.getElementById('model');
    const systemEl = document.getElementById('systemPrompt');

    if(!apiBase){
      appendBubble('API Base URLを設定してください。', 'ai', 'error');
      return;
    }

    // show user message
    appendBubble(msg, 'user');
    inputEl.value = '';
    sendBtn.disabled = true;

    // add user message to history
    chatMessages.push({role: 'user', content: msg});

    // ensure system prompt is present as first message if provided
    const systemPrompt = (systemEl && systemEl.value && systemEl.value.trim()) ? systemEl.value.trim() : DEFAULT_SYSTEM_PROMPT;
    if(systemPrompt){
      // if chatMessages doesn't already have system at index 0, unshift it
      if(!chatMessages.length || chatMessages[0].role !== 'system'){
        chatMessages.unshift({role:'system', content: systemPrompt});
      } else {
        chatMessages[0].content = systemPrompt;
      }
    }

    // typing indicator
    const typing = appendBubble('typing...', 'ai', 'typing');

    try{
      const model = (modelEl && modelEl.value) ? modelEl.value.trim() : DEFAULT_MODEL;
      const url = apiBase.replace(/\/$/, '') + '/v1/chat/completions';

      // prepare a few payload candidates to match different server expectations
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

      typing.remove();

      if(!res){
        appendBubble('サーバへ接続できませんでした（ネットワークエラー）。', 'ai', 'error');
        return;
      }

      if(!res.ok){
        appendBubble(`エラー: ${res.status} ${res.statusText}\n${bodyText}\n(Payload used: ${JSON.stringify(usedPayload)})`, 'ai', 'error');
        return;
      }

      // parse response
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

      // push assistant message to history
      chatMessages.push({role:'assistant', content: reply});
      // render assistant reply as Markdown
      appendMarkdownBubble(reply, 'ai');

    }catch(err){
      typing.remove();
      appendBubble('エラー: ' + err.message, 'ai', 'error');
    }finally{
      sendBtn.disabled = false;
      inputEl.focus();
    }
  }

  inputForm.addEventListener('submit', (e)=>{
    e.preventDefault();
    const v = inputEl.value.trim();
    if(!v) return;
    sendMessage(v);
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