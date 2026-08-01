/* =========================================================
   あんざんチャレンジ - アプリ本体
   仕様書「暗算アプリ仕様.md」に基づくサンプル実装
   ========================================================= */
(function(){
  "use strict";

  /* ---------- 既定データ（users.js が読み込めなかった場合のフォールバック） ---------- */
  const DEFAULT_USERS = [
    {id:1, name:"ゆうた"},
    {id:2, name:"さくら"},
    {id:3, name:"けんた"}
  ];
  const LS_RESULTS_PREFIX = "anzan_results_"; // + userId

  const MODE_LABELS = {add:"たしざん", sub:"ひきざん", mul:"かけざん", div:"わりざん"};
  const MODE_ICONS  = {add:"➕", sub:"➖", mul:"✖️", div:"➗"};
  const DIFF_LABELS = {easy:"かんたん", normal:"ふつう", hard:"むずかしい"};

  /* ---------- 設定（config.js 相当。問題数などをモードごとに外部管理） ----------
     config.js が index.html より先に <script> で読み込まれ、
     window.APP_CONFIG にセットされている想定。 */
  const DEFAULT_CONFIG = {
    questionsPerMode: { add:20, sub:20, mul:20, div:20 }
  };
  const externalConfig = (window.APP_CONFIG && window.APP_CONFIG.questionsPerMode) || {};
  const CONFIG = {
    questionsPerMode: Object.assign({}, DEFAULT_CONFIG.questionsPerMode, externalConfig)
  };

  function questionsFor(mode){
    const n = CONFIG.questionsPerMode[mode];
    return (typeof n === "number" && n > 0) ? n : DEFAULT_CONFIG.questionsPerMode[mode];
  }

  /* ---------- 状態 ---------- */
  const state = {
    users: [],
    currentUser: null,
    mode: null,
    difficulty: null,
    problems: [],
    index: 0,
    totalQuestions: 0,
    results: [],
    startTime: 0,
    timerId: null
  };

  /* ---------- ユーティリティ ---------- */
  function rand(min, max){ return Math.floor(Math.random()*(max-min+1))+min; }
  function fmtTime(sec){
    const m = Math.floor(sec/60), s = Math.floor(sec%60);
    return m + ":" + String(s).padStart(2,"0");
  }
  function showScreen(id){
    document.querySelectorAll(".screen").forEach(s=>s.classList.remove("active"));
    document.getElementById(id).classList.add("active");
  }
  function toast(msg){
    const t = document.getElementById("toast");
    t.textContent = msg;
    t.classList.add("show");
    setTimeout(()=>t.classList.remove("show"), 1600);
  }

  /* ---------- 音（Web Audio。外部音源ファイル不要） ----------
     すべてその場で波形を合成しています。音声ファイル(mp3等)は
     一切使っていません。派手さは各関数内の音階・波形・本数を
     変えるだけで調整できます。 */
  let actx = null;
  let masterBus = null; // 音割れ防止用のコンプレッサーを通した出力バス

  function audioCtx(){
    if(!actx){
      actx = new (window.AudioContext||window.webkitAudioContext)();
      const comp = actx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.knee.value = 24;
      comp.ratio.value = 6;
      comp.attack.value = 0.003;
      comp.release.value = 0.18;
      comp.connect(actx.destination);
      masterBus = comp;
    }
    return actx;
  }

  // 単音を鳴らす（type: sine/triangle/square/sawtooth, glideTo: 途中で滑らせる目標周波数）
  function tone(ctx, freq, startOffset, dur, opts){
    opts = opts || {};
    const type = opts.type || "sine";
    const peakGain = opts.peakGain != null ? opts.peakGain : 0.2;
    const detune = opts.detune || 0;
    const glideTo = opts.glideTo || null;

    const t0 = ctx.currentTime + startOffset;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if(glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t0+dur);
    osc.detune.value = detune;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peakGain, t0+0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0+dur);
    osc.connect(gain).connect(masterBus);
    osc.start(t0);
    osc.stop(t0+dur+0.03);
  }

  // ノイズバースト（キラキラのスパークルや、衝撃音の「ドン」に使用）
  function noiseBurst(ctx, startOffset, dur, opts){
    opts = opts || {};
    const peakGain = opts.peakGain != null ? opts.peakGain : 0.2;
    const filterType = opts.filterType || "bandpass";
    const filterFreq = opts.filterFreq || 1200;
    const Q = opts.Q != null ? opts.Q : 1;

    const t0 = ctx.currentTime + startOffset;
    const size = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buffer = ctx.createBuffer(1, size, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for(let i=0;i<size;i++){ data[i] = Math.random()*2-1; }

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = filterFreq;
    filter.Q.value = Q;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peakGain, t0+0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0+dur);
    src.connect(filter).connect(gain).connect(masterBus);
    src.start(t0);
    src.stop(t0+dur+0.03);
  }

  // 正解音：ド→ミ→ソ→ド(1オクターブ上)の明るいアルペジオに、
  // 1オクターブ上の倍音を薄く重ねてキラキラ感を出し、最後に
  // ハイパスノイズのスパークルを添える「ファンファーレ」風。
  function playCorrectSound(){
    try{
      const ctx = audioCtx();
      const notes = [523.25, 659.25, 783.99, 1046.50]; // C5 E5 G5 C6
      notes.forEach((f, i)=>{
        const start = i*0.075;
        tone(ctx, f,   start, 0.24, {type:"triangle", peakGain:0.24});
        tone(ctx, f*2, start, 0.16, {type:"sine",     peakGain:0.07}); // きらめく倍音
      });
      noiseBurst(ctx, notes.length*0.075, 0.35, {peakGain:0.13, filterType:"highpass", filterFreq:6000, Q:0.7});
    }catch(e){ /* 音が出せない環境は無視 */ }
  }

  // 不正解音：デチューンした矩形波2本を少し下向きにグライドさせる
  // 「ブブー」というブザー音を2発、さらに低音のノイズで「ドスッ」と
  // した衝撃感を足した、はっきり分かる残念系サウンド。
  function playWrongSound(){
    try{
      const ctx = audioCtx();
      const buzzes = [ {f:311.13, glide:233.08}, {f:220.00, glide:174.61} ]; // Eb4→Bb3, A3→F3
      buzzes.forEach((n, i)=>{
        const start = i*0.2;
        tone(ctx, n.f, start, 0.24, {type:"square", peakGain:0.15, glideTo:n.glide});
        tone(ctx, n.f, start, 0.24, {type:"square", peakGain:0.1,  glideTo:n.glide, detune:14});
      });
      noiseBurst(ctx, 0, 0.14, {peakGain:0.2, filterType:"lowpass", filterFreq:350, Q:0.7});
    }catch(e){ /* 音が出せない環境は無視 */ }
  }

  // 結果画面用のファンファーレ（約2秒）：
  // 「タ・タ・ター」の主題 → 駆け上がる合いの手 → きらめき →
  // ベース入りのメジャーコードで締める、という4部構成のミニ楽曲。
  function playResultFanfare(){
    try{
      const ctx = audioCtx();

      // ① 主題「タ・タ・ター」（0.0〜0.7秒）
      const motif = [
        {f:523.25, t:0.00, d:0.12}, // C5
        {f:523.25, t:0.14, d:0.12}, // C5
        {f:659.25, t:0.28, d:0.20}, // E5（のばす）
        {f:783.99, t:0.48, d:0.22}  // G5（のばす）
      ];
      motif.forEach(n=>{
        tone(ctx, n.f, n.t, n.d, {type:"triangle", peakGain:0.24});
        tone(ctx, n.f*2, n.t, n.d*0.7, {type:"sine", peakGain:0.05});
      });

      // ② 駆け上がる合いの手（0.75〜1.0秒）
      const run = [1046.50, 1174.66, 1318.51]; // C6 D6 E6
      run.forEach((f,i)=> tone(ctx, f, 0.75 + i*0.08, 0.12, {type:"triangle", peakGain:0.2}));

      // ③ 中間のきらめき（0.95〜1.15秒）
      noiseBurst(ctx, 0.95, 0.18, {peakGain:0.09, filterType:"highpass", filterFreq:6000, Q:0.6});

      // ④ フィナーレ：ベース＋メジャーコードで締める（1.05〜1.9秒）
      const finalStart = 1.05;
      const finalDur = 0.85;
      tone(ctx, 130.81, finalStart, finalDur, {type:"sine", peakGain:0.13}); // ベースC3
      const chord = [523.25, 659.25, 783.99, 1046.50]; // C E G C（メジャーコード）
      chord.forEach(f=>{
        tone(ctx, f,   finalStart, finalDur,       {type:"triangle", peakGain:0.2});
        tone(ctx, f*2, finalStart, finalDur*0.8,   {type:"sine",     peakGain:0.06});
      });
      noiseBurst(ctx, finalStart, finalDur*0.9, {peakGain:0.1, filterType:"highpass", filterFreq:5500, Q:0.5});

      // 最後にもう一段、高音のアクセントを添えて余韻を残す（1.55〜2.05秒）
      const sparkle = [1046.50, 1318.51, 1567.98]; // C6 E6 G6
      sparkle.forEach((f,i)=> tone(ctx, f, 1.55 + i*0.10, 0.3, {type:"sine", peakGain:0.09}));
    }catch(e){ /* 音が出せない環境は無視 */ }
  }

  /* ---------- ユーザ管理（users.js を起動のたびに必ず反映） ---------- */
  function loadUsers(){
    const fileUsers = (window.APP_USERS && Array.isArray(window.APP_USERS)) ? window.APP_USERS : null;
    // users.js の内容を毎回そのまま正として使う（localStorageでの上書きはしない）
    state.users = (fileUsers && fileUsers.length > 0)
      ? fileUsers.map(u=>({ id:u.id, name:String(u.name) }))
      : DEFAULT_USERS.slice();
  }

  const AVATAR_COLORS = ["#FF7A45", "#2EC4B6", "#FFC93C"];

  function renderUserList(){
    const list = document.getElementById("userList");
    list.innerHTML = "";
    state.users.forEach((u, i)=>{
      const card = document.createElement("button");
      card.className = "user-card";
      card.innerHTML =
        '<div class="user-avatar" style="background:'+AVATAR_COLORS[i%3]+'">'+u.name.charAt(0)+'</div>'+
        '<div class="user-name">'+escapeHtml(u.name)+'</div>'+
        '<div class="user-arrow">›</div>';
      card.onclick = ()=> App.selectUser(u);
      list.appendChild(card);
    });
  }
  function escapeHtml(s){
    return s.replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  }

  /* ---------- 問題生成 ---------- */
  function genAdd(diff){
    let a,b;
    if(diff==="easy"){
      // かんたん：1桁 + 1桁
      a=rand(1,9); b=rand(1,9);
    } else if(diff==="normal"){
      // ふつう：1桁 + 2桁（順序はランダムに入れ替える）
      const oneDigit = rand(1,9);
      const twoDigit = rand(10,99);
      if(rand(0,1)===0){ a=oneDigit; b=twoDigit; } else { a=twoDigit; b=oneDigit; }
    } else {
      // むずかしい：2桁 + 2桁
      a=rand(10,99); b=rand(10,99);
    }
    return {a,b,op:"+",answer:a+b};
  }
  function genSub(diff){
    let a,b;
    if(diff==="easy"){
      // かんたん：1桁 − 1桁
      a=rand(1,9); b=rand(1,9);
    } else if(diff==="normal"){
      // ふつう：2桁 − 1桁
      a=rand(10,99); b=rand(1,9);
    } else {
      // むずかしい：2桁 − 2桁
      a=rand(10,99); b=rand(10,99);
    }
    if(b>a){ const t=a; a=b; b=t; } // 答えが負にならないように大小を入れ替える
    return {a,b,op:"-",answer:a-b};
  }
  function genMul(diff){
    let a,b;
    if(diff==="easy"){
      // かんたん：九九（1桁×1桁）をランダムに出題
      a=rand(1,9); b=rand(1,9);
    } else if(diff==="normal"){
      // ふつう：2桁 × 1桁
      a=rand(10,99); b=rand(1,9);
    } else {
      // むずかしい：2桁 × 2桁
      a=rand(10,99); b=rand(10,99);
    }
    return {a,b,op:"×",answer:a*b};
  }
  function genDiv(diff){
    let divisor, quotient;
    if(diff==="easy"){
      // かんたん：九九を使った割り算（被除数・除数とも1桁の掛け算の逆算）
      divisor=rand(1,9); quotient=rand(1,9);
    } else if(diff==="normal"){
      // ふつう：2桁 ÷ 1桁（被除数が必ず2桁になるように調整）
      divisor=rand(1,9);
      const minQ = Math.ceil(10/divisor);
      const maxQ = Math.floor(99/divisor);
      quotient = rand(minQ, maxQ);
    } else {
      // むずかしい：2桁 ÷ 2桁（除数・被除数とも2桁になるように調整）
      divisor = rand(10,49); // 49×2=98 で被除数が2桁に収まる上限
      const maxQ = Math.floor(99/divisor);
      quotient = rand(2, maxQ);
    }
    const dividend = divisor*quotient;
    return {a:dividend, b:divisor, op:"÷", answer:quotient};
  }
  const GENERATORS = {add:genAdd, sub:genSub, mul:genMul, div:genDiv};

  function generateProblems(mode, diff){
    const list = [];
    const count = questionsFor(mode);
    for(let i=0;i<count;i++){
      list.push(GENERATORS[mode](diff));
    }
    return list;
  }

  /* ---------- 結果保存（モード×難易度ごとに最大20件、古いものから削除） ---------- */
  const MAX_RESULTS_PER_BUCKET = 20;

  function emptyResultsStore(){
    const store = {};
    Object.keys(MODE_LABELS).forEach(mode=>{
      store[mode] = {};
      Object.keys(DIFF_LABELS).forEach(diff=>{ store[mode][diff] = []; });
    });
    return store;
  }

  function loadUserResultsStore(userId){
    const raw = localStorage.getItem(LS_RESULTS_PREFIX+userId);
    const store = emptyResultsStore();
    if(!raw) return store;
    try{
      const parsed = JSON.parse(raw);
      // 旧バージョン（フラット配列）で保存されたデータが残っていた場合は
      // 形式が異なるため引き継がず、新しい構造で使い始める。
      if(Array.isArray(parsed)) return store;
      Object.keys(MODE_LABELS).forEach(mode=>{
        Object.keys(DIFF_LABELS).forEach(diff=>{
          if(parsed[mode] && Array.isArray(parsed[mode][diff])){
            store[mode][diff] = parsed[mode][diff];
          }
        });
      });
      return store;
    }catch(e){ return store; }
  }

  function saveUserSession(userId, session){
    const store = loadUserResultsStore(userId);
    const bucket = store[session.mode][session.difficulty];
    bucket.push(session);
    while(bucket.length > MAX_RESULTS_PER_BUCKET){
      bucket.shift(); // 古いものから削除
    }
    localStorage.setItem(LS_RESULTS_PREFIX+userId, JSON.stringify(store));
  }

  // 指定したモード（かんたん・ふつう・むずかしい すべて）の記録を消す
  function resetModeResults(userId, mode){
    const store = loadUserResultsStore(userId);
    store[mode] = { easy:[], normal:[], hard:[] };
    localStorage.setItem(LS_RESULTS_PREFIX+userId, JSON.stringify(store));
  }

  /* ---------- マスコット表情 ---------- */
  function setMascot(elId, symbol){
    document.getElementById(elId).querySelector("use").setAttribute("href", "#"+symbol);
  }

  /* =========================================================
     App: 画面遷移・イベント処理
     ========================================================= */
  const App = {

    init(){
      loadUsers();
      renderUserList();
      buildModeGrid();
      bindKeypad();
      registerServiceWorker();
    },

    /* ---- 画面遷移 ---- */
    goUserSelect(){
      renderUserList();
      showScreen("screen-user");
    },
    goModeSelect(){
      document.getElementById("modeUserLabel").textContent = state.currentUser.name + " さん";
      // 選択状態リセット
      state.mode = null; state.difficulty = null;
      document.querySelectorAll(".mode-card").forEach(c=>c.classList.remove("selected"));
      document.querySelectorAll(".diff-btn").forEach(c=>c.classList.remove("selected"));
      document.getElementById("startBtn").disabled = true;
      showScreen("screen-mode");
    },
    selectUser(u){
      state.currentUser = u;
      App.goModeSelect();
    },

    goHistory(){
      document.getElementById("historyUserLabel").textContent = state.currentUser.name + "さんの きろく";
      renderHistory();
      showScreen("screen-history");
    },

    resetModeHistory(mode){
      const ok = confirm(state.currentUser.name+"さんの「"+MODE_LABELS[mode]+"」のきろくを\nぜんぶ けしますか？（もとに戻せません）");
      if(!ok) return;
      resetModeResults(state.currentUser.id, mode);
      renderHistory();
      toast(MODE_LABELS[mode]+"のきろくを けしました");
    },

    selectDifficulty(diff){
      if(!state.mode) return;
      state.difficulty = diff;
      document.querySelectorAll(".diff-btn").forEach(b=>{
        b.classList.toggle("selected", b.dataset.diff===diff);
      });
      document.getElementById("startBtn").disabled = false;
    },

    startCalc(){
      state.problems = generateProblems(state.mode, state.difficulty);
      state.totalQuestions = state.problems.length;
      state.index = 0;
      state.results = [];
      state.startTime = Date.now();
      showScreen("screen-calc");
      renderProblem();
      startTimer();
    },

    confirmAnswer(){
      const btn = document.getElementById("confirmBtn");
      if(btn.disabled) return;
      const p = state.problems[state.index];
      const userAnswer = parseInt(currentInput || "0", 10);
      const correct = userAnswer === p.answer;

      state.results.push({
        no: state.index+1,
        question: p.a+" "+p.op+" "+p.b,
        userAnswer: userAnswer,
        correctAnswer: p.answer,
        correct: correct
      });

      showFeedback(correct, p.answer);
    },

    /* ---- ユーザ設定モーダル（表示専用。名前の変更は users.js を編集） ---- */
    openUserEdit(){
      const rows = document.getElementById("userEditRows");
      rows.innerHTML = "";
      state.users.forEach((u)=>{
        const row = document.createElement("div");
        row.className = "modal-row";
        row.innerHTML =
          '<span class="modal-user-name">'+escapeHtml(u.name)+'</span>' +
          '<span class="modal-user-id">id: '+u.id+'</span>';
        rows.appendChild(row);
      });
      document.getElementById("userEditModal").classList.add("show");
    },
    closeUserEdit(){
      document.getElementById("userEditModal").classList.remove("show");
    },
    exportUsers(){
      downloadJson(state.users, "users_backup.json");
    }
  };

  function downloadJson(obj, filename){
    const blob = new Blob([JSON.stringify(obj, null, 2)], {type:"application/json"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast("JSONを保存しました");
  }

  /* ---------- モード選択グリッド構築 ---------- */
  function buildModeGrid(){
    const grid = document.getElementById("modeGrid");
    grid.innerHTML = "";
    Object.keys(MODE_LABELS).forEach(mode=>{
      const card = document.createElement("button");
      card.className = "mode-card";
      card.dataset.mode = mode;
      card.innerHTML =
        '<span class="mode-icon">'+MODE_ICONS[mode]+'</span>'+MODE_LABELS[mode]+
        '<span class="mode-count">'+questionsFor(mode)+'もん</span>';
      if(mode === state.mode) card.classList.add("selected");
      card.onclick = ()=>{
        state.mode = mode;
        document.querySelectorAll(".mode-card").forEach(c=>c.classList.toggle("selected", c===card));
      };
      grid.appendChild(card);
    });
  }

  /* ---------- 過去の結果 画面 ---------- */
  function fmtDateTime(iso){
    const d = new Date(iso);
    const mm = d.getMonth()+1, dd = d.getDate();
    const hh = String(d.getHours()).padStart(2,"0"), mi = String(d.getMinutes()).padStart(2,"0");
    return mm+"/"+dd+" "+hh+":"+mi;
  }

  function renderHistory(){
    const store = loadUserResultsStore(state.currentUser.id);
    const container = document.getElementById("historyContent");
    container.innerHTML = "";

    Object.keys(MODE_LABELS).forEach(mode=>{
      const modeSection = document.createElement("div");
      modeSection.className = "history-mode";
      modeSection.innerHTML =
        '<div class="history-mode-header">' +
          '<h3 class="history-mode-title">'+MODE_ICONS[mode]+' '+MODE_LABELS[mode]+'</h3>' +
          '<button class="history-reset-btn" onclick="App.resetModeHistory(\''+mode+'\')">🗑 リセット</button>' +
        '</div>';

      Object.keys(DIFF_LABELS).forEach(diff=>{
        const sessions = (store[mode] && store[mode][diff]) || [];
        const block = document.createElement("div");
        block.className = "history-diff-block";

        let rowsHtml;
        if(sessions.length === 0){
          rowsHtml = '<div class="history-empty">まだきろくがありません</div>';
        } else {
          // 新しいものが上にくるように並べ替えて表示
          rowsHtml = sessions.slice().reverse().map(s=>{
            const rate = Math.round((s.correctCount / s.totalCount) * 100);
            return (
              '<div class="history-row">' +
                '<span class="hr-date">' + fmtDateTime(s.date) + '</span>' +
                '<span class="hr-score">' + s.correctCount + '/' + s.totalCount + '（' + rate + '%）</span>' +
                '<span class="hr-time">' + fmtTime(s.totalTimeSec) + '</span>' +
              '</div>'
            );
          }).join("");
        }

        block.innerHTML =
          '<div class="history-diff-title">' + DIFF_LABELS[diff] +
          '<span class="history-diff-count">' + sessions.length + ' / ' + MAX_RESULTS_PER_BUCKET + '件</span></div>' +
          rowsHtml;
        modeSection.appendChild(block);
      });

      container.appendChild(modeSection);
    });
  }

  /* ---------- 計算画面: 入力・表示 ---------- */
  let currentInput = "";
  const MAX_DIGITS = 6;

  function renderProblem(){
    currentInput = "";
    updateAnswerBox();
    const p = state.problems[state.index];
    document.getElementById("problemText").textContent = p.a+" "+p.op+" "+p.b+" =";
    document.getElementById("progressLabel").textContent = (state.index+1)+" / "+state.totalQuestions;
    document.getElementById("progressFill").style.width = Math.round(((state.index)/state.totalQuestions)*100)+"%";
  }

  function updateAnswerBox(){
    const box = document.getElementById("answerBox");
    if(currentInput===""){
      box.textContent = "こたえ";
      box.classList.add("placeholder");
    } else {
      box.textContent = currentInput;
      box.classList.remove("placeholder");
    }
    document.getElementById("confirmBtn").disabled = currentInput === "";
  }

  function bindKeypad(){
    document.getElementById("keypad").addEventListener("click", (e)=>{
      const btn = e.target.closest(".key");
      if(!btn) return;
      const k = btn.dataset.k;
      if(k==="back"){ currentInput = currentInput.slice(0,-1); }
      else if(k==="clear"){ currentInput = ""; }
      else { if(currentInput.length < MAX_DIGITS) currentInput += k; }
      updateAnswerBox();
    });
    document.getElementById("confirmBtn").addEventListener("click", App.confirmAnswer);
  }

  /* ---------- フィードバック表示 ---------- */
  function showFeedback(correct, correctAnswer){
    const overlay = document.getElementById("feedbackOverlay");
    const mark = document.getElementById("feedbackMark");
    const sub = document.getElementById("feedbackSub");

    mark.className = "feedback-mark pop-in " + (correct?"correct":"wrong");
    mark.textContent = correct ? "〇" : "×";
    sub.textContent = correct ? "せいかい！" : "こたえ: " + correctAnswer;
    setMascot("mascotFeedback", correct ? "mascot-happy" : "mascot-sad");

    overlay.classList.add("show");
    if(correct) playCorrectSound(); else playWrongSound();

    setTimeout(()=>{
      overlay.classList.remove("show");
      state.index++;
      if(state.index >= state.totalQuestions){
        finishSession();
      } else {
        renderProblem();
      }
    }, correct ? 900 : 1500);
  }

  /* ---------- タイマー ---------- */
  function startTimer(){
    clearInterval(state.timerId);
    state.timerId = setInterval(()=>{
      const sec = (Date.now()-state.startTime)/1000;
      document.getElementById("timerLabel").textContent = fmtTime(sec);
    }, 250);
  }
  function stopTimer(){
    clearInterval(state.timerId);
  }

  /* ---------- 結果画面 ---------- */
  function finishSession(){
    stopTimer();
    const totalSec = (Date.now()-state.startTime)/1000;
    const correctCount = state.results.filter(r=>r.correct).length;

    const session = {
      userId: state.currentUser.id,
      userName: state.currentUser.name,
      mode: state.mode,
      modeLabel: MODE_LABELS[state.mode],
      difficulty: state.difficulty,
      difficultyLabel: DIFF_LABELS[state.difficulty],
      date: new Date().toISOString(),
      totalTimeSec: Math.round(totalSec*10)/10,
      correctCount: correctCount,
      totalCount: state.totalQuestions,
      details: state.results
    };
    saveUserSession(state.currentUser.id, session);

    document.getElementById("resultTitle").textContent =
      state.currentUser.name+"さんの けっか（"+MODE_LABELS[state.mode]+" / "+DIFF_LABELS[state.difficulty]+"）";
    document.getElementById("resScore").textContent = correctCount+" / "+state.totalQuestions;
    document.getElementById("resTime").textContent = fmtTime(totalSec);
    document.getElementById("resRate").textContent = Math.round((correctCount/state.totalQuestions)*100)+"%";

    const list = document.getElementById("resultList");
    list.innerHTML = "";
    state.results.forEach(r=>{
      const row = document.createElement("div");
      row.className = "result-row " + (r.correct?"correct":"wrong");
      row.innerHTML =
        '<div class="rno">'+r.no+'</div>'+
        '<div class="rq">'+r.question+' = '+r.userAnswer+
          (r.correct? '' : ' <span class="rcorrect">（正解: '+r.correctAnswer+'）</span>')+
        '</div>'+
        '<div class="rmark">'+(r.correct?"〇":"×")+'</div>';
      list.appendChild(row);
    });

    showScreen("screen-result");
    playResultFanfare();
  }

  /* ---------- Service Worker（PWA。file://では登録スキップ） ---------- */
  function registerServiceWorker(){
    if("serviceWorker" in navigator && location.protocol.startsWith("http")){
      navigator.serviceWorker.register("sw.js").catch(()=>{});
    }
  }

  /* ---------- 起動 ---------- */
  window.App = App;
  document.addEventListener("DOMContentLoaded", App.init);
})();