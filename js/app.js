(() => {
  "use strict";
  const cfg = window.SHASAIDOVS_CONFIG || {};
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const supabaseReady = window.supabase && cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY &&
    !cfg.SUPABASE_URL.includes("YOUR-PROJECT") && !cfg.SUPABASE_ANON_KEY.includes("YOUR_SUPABASE");
  let db = null, session = null, profile = null, isSignup = false, currentWeek = 0;
  let recipes = [], weekDraft = [], shopping = [];

  const DAYS = ["Понедельник","Вторник","Среда","Четверг","Пятница","Суббота","Воскресенье"];
  const SHORT_DAYS = ["Пн","Вт","Ср","Чт","Пт","Сб","Вс"];
  const MEALS = ["Завтрак","Обед","Ужин"];

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  }
  function toast(message) {
    const el = $("#globalMessage"); el.textContent = message; el.classList.remove("hidden");
    window.clearTimeout(toast.timer); toast.timer = window.setTimeout(() => el.classList.add("hidden"), 4200);
  }
  function setAuthMessage(message, good=false) {
    const el = $("#authMessage"); el.textContent = message; el.style.color = good ? "var(--green)" : "var(--danger)";
  }
  function setRecipeMessage(message) { $("#recipeFormMessage").textContent = message || ""; }
  function setAuthMode(signup) {
    isSignup = signup; $("#loginTab").classList.toggle("active", !signup); $("#signupTab").classList.toggle("active", signup);
    $("#nameField").classList.toggle("hidden", !signup); $("#displayName").required = signup;
    $("#authSubmit").textContent = signup ? "Создать аккаунт" : "Войти"; setAuthMessage("");
  }
  function showLoggedOut() { $("#authView").classList.remove("hidden"); $("#appView").classList.add("hidden"); $("#topUser").classList.add("hidden"); }
  function showLoggedIn() {
    $("#authView").classList.add("hidden"); $("#appView").classList.remove("hidden"); $("#topUser").classList.remove("hidden");
    $("#topUserName").textContent = profile?.display_name || session?.user?.email || "Пользователь";
    const admin = profile?.role === "admin";
    $("#topRole").textContent = admin ? "Администратор" : "Пользователь";
    $("#adminNav").classList.toggle("hidden", !admin);
    if (!admin && $("#adminView").classList.contains("active")) activateView("weeklyView");
  }
  function activateView(id) {
    $$(".content-view").forEach(v => v.classList.toggle("hidden", v.id !== id));
    $$(".nav-btn").forEach(b => b.classList.toggle("active", b.dataset.view === id));
    if (id === "recipesView") renderRecipes();
    if (id === "weeklyView") renderWeek();
    if (id === "shoppingView") renderShopping();
    if (id === "adminView" && profile?.role === "admin") loadAdmin();
  }
  async function loadProfile() {
    const { data, error } = await db.from("profiles").select("id, display_name, role").eq("id", session.user.id).single();
    if (error) throw error; profile = data;
  }
  async function loadRecipes() {
    const { data, error } = await db.from("recipes").select("id,name,description,minutes,portions,created_at").order("created_at", { ascending: false });
    if (error) throw error; recipes = data || [];
  }
  function weekStart(offset) {
    const now = new Date(); const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + offset * 7); return d;
  }
  function dateISO(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
  function fmtDate(d, options={day:"numeric",month:"short"}) { return d.toLocaleDateString("ru-RU", options); }
  function blankWeek() { return Array.from({length:7}, () => MEALS.map(type => ({type, recipe_id:"", custom_name:""}))); }
  async function loadWeek() {
    const start = dateISO(weekStart(currentWeek)), end = dateISO(new Date(weekStart(currentWeek).getTime()+6*86400000));
    const { data, error } = await db.from("menus").select("id,menu_date,meal_type,recipe_id,custom_name").eq("user_id",session.user.id).gte("menu_date",start).lte("menu_date",end);
    if (error) throw error;
    weekDraft = blankWeek();
    for (const row of (data || [])) {
      const day = Math.round((new Date(`${row.menu_date}T12:00:00`) - new Date(`${start}T12:00:00`))/86400000);
      const mi = MEALS.indexOf(row.meal_type);
      if (day >= 0 && day < 7 && mi >= 0) weekDraft[day][mi] = { type:row.meal_type, recipe_id:row.recipe_id || "", custom_name:row.custom_name || "" };
    }
    renderWeek();
  }
  function renderWeek() {
    if (!session) return;
    const start = weekStart(currentWeek), end = new Date(start.getTime()+6*86400000);
    $("#weekRange").textContent = `${fmtDate(start)} — ${fmtDate(end,{day:"numeric",month:"short",year:"numeric"})}`;
    if (!weekDraft.length) weekDraft = blankWeek();
    $("#weekGrid").innerHTML = weekDraft.map((day, i) => {
      const d = new Date(start.getTime()+i*86400000);
      return `<article class="day-card"><div class="day-title"><b>${SHORT_DAYS[i]} · ${DAYS[i]}</b><small>${fmtDate(d)}</small></div>` +
        day.map((meal,j) => `<div class="meal-slot"><label>${meal.type}</label><select data-day="${i}" data-meal="${j}" aria-label="${meal.type}, ${DAYS[i]}"><option value="">— Не выбрано —</option>${recipes.map(r=>`<option value="${r.id}" ${meal.recipe_id===r.id?"selected":""}>${escapeHtml(r.name)}</option>`).join("")}<option value="__custom__" ${meal.custom_name?"selected":""}>Своё блюдо…</option></select>${meal.custom_name?`<input data-custom-day="${i}" data-custom-meal="${j}" value="${escapeHtml(meal.custom_name)}" maxlength="120" placeholder="Название блюда">`:""}</div>`).join("") + `</article>`;
    }).join("");
    $$("#weekGrid select").forEach(sel => sel.addEventListener("change", () => {
      const d=+sel.dataset.day,m=+sel.dataset.meal,v=sel.value;
      weekDraft[d][m].recipe_id = v && v !== "__custom__" ? v : "";
      weekDraft[d][m].custom_name = v === "__custom__" ? (weekDraft[d][m].custom_name || "") : "";
      if (v === "__custom__" && !weekDraft[d][m].custom_name) weekDraft[d][m].custom_name = " ";
      renderWeek();
      if (v === "__custom__") { const input = $(`[data-custom-day="${d}"][data-custom-meal="${m}"]`); if(input){input.focus();input.select();} }
    }));
    $$("[data-custom-day]").forEach(inp => inp.addEventListener("input", () => { weekDraft[+inp.dataset.customDay][+inp.dataset.customMeal].custom_name=inp.value; }));
  }
  async function saveWeek() {
    const start = dateISO(weekStart(currentWeek)), end = dateISO(new Date(weekStart(currentWeek).getTime()+6*86400000));
    const del = await db.from("menus").delete().eq("user_id",session.user.id).gte("menu_date",start).lte("menu_date",end);
    if (del.error) throw del.error;
    const rows = [];
    weekDraft.forEach((day,i) => day.forEach(meal => {
      const custom = (meal.custom_name || "").trim();
      if (meal.recipe_id || custom) rows.push({user_id:session.user.id,menu_date:dateISO(new Date(weekStart(currentWeek).getTime()+i*86400000)),meal_type:meal.type,recipe_id:meal.recipe_id || null,custom_name:meal.recipe_id ? null : custom});
    }));
    if (rows.length) { const ins=await db.from("menus").insert(rows); if(ins.error) throw ins.error; }
    toast("Меню сохранено в Supabase.");
  }
  function renderRecipes() {
    $("#recipesGrid").innerHTML = recipes.length ? recipes.map(r => `<article class="recipe-card"><h3>${escapeHtml(r.name)}</h3><p>${escapeHtml(r.description || "Описание не добавлено.")}</p><div class="recipe-meta"><span>◷ ${r.minutes} мин.</span><span>♧ ${r.portions} порц.</span></div><button class="btn btn-outline btn-small" data-add-recipe="${r.id}">Добавить в меню</button></article>`).join("") : `<div class="card recipe-card">Пока нет рецептов. ${profile?.role==="admin"?"Добавьте первый рецепт.":"Администратор скоро добавит рецепты."}</div>`;
    $$("[data-add-recipe]").forEach(b=>b.onclick=()=>{const r=recipes.find(x=>x.id===b.dataset.addRecipe);if(!r)return;activateView("weeklyView");const empty=weekDraft.flat().find(m=>!m.recipe_id&&!m.custom_name.trim());if(!empty){toast("В меню нет свободных слотов. Выберите другой день или сохраните изменения.");return;}empty.recipe_id=r.id;empty.custom_name="";renderWeek();toast("Рецепт добавлен в первый свободный слот. Нажмите «Сохранить меню».");});
  }
  function renderShopping() {
    const key=`shasaidovs-shopping-${session.user.id}`;let items=[];try{items=JSON.parse(localStorage.getItem(key)||"[]")}catch{}
    $("#shoppingList").innerHTML=items.map((it,i)=>`<div class="shopping-row ${it.done?"done":""}"><input type="checkbox" data-shop-check="${i}" ${it.done?"checked":""}><span>${escapeHtml(it.name)}</span><button class="text-btn" data-shop-delete="${i}">Удалить</button></div>`).join("") || `<p class="hint">Список покупок пока пуст.</p>`;
    $$("[data-shop-check]").forEach(el=>el.onchange=()=>{items[+el.dataset.shopCheck].done=el.checked;localStorage.setItem(key,JSON.stringify(items));renderShopping()});
    $$("[data-shop-delete]").forEach(el=>el.onclick=()=>{items.splice(+el.dataset.shopDelete,1);localStorage.setItem(key,JSON.stringify(items));renderShopping()});
  }
  async function loadAdmin() {
    if(profile?.role!=="admin") { toast("Недостаточно прав."); activateView("weeklyView"); return; }
    $("#usersTable").innerHTML=`<tr><td colspan="4">Загрузка пользователей…</td></tr>`;
    try {
      const {data,error}=await db.rpc("admin_list_users");
      if(error) throw error;
      const users=data||[];
      $("#userCount").textContent=users.length;$("#recipeCount").textContent=recipes.length;
      $("#usersTable").innerHTML=users.map(u=>`<tr><td>${escapeHtml(u.display_name||"Без имени")}</td><td>${escapeHtml(u.email||"")}</td><td><span class="role-pill">${u.role==="admin"?"Администратор":"Пользователь"}</span></td><td>${u.id===session.user.id?'<span class="hint">Текущий аккаунт</span>':`<select data-role-user="${u.id}" aria-label="Роль пользователя"><option value="user" ${u.role==="user"?"selected":""}>Пользователь</option><option value="admin" ${u.role==="admin"?"selected":""}>Администратор</option></select>`}</td></tr>`).join("") || `<tr><td colspan="4">Пользователей пока нет.</td></tr>`;
      $$("[data-role-user]").forEach(sel=>sel.onchange=async()=>{const role=sel.value;if(!confirm(`Изменить роль пользователя на «${role}»?`)){loadAdmin();return;}try{const {error}=await db.rpc("admin_set_user_role",{target_user_id:sel.dataset.roleUser,new_role:role});if(error)throw error;toast("Роль пользователя обновлена.");await loadAdmin();}catch(e){toast("Не удалось изменить роль: "+e.message);loadAdmin();}});
      $("#adminRecipes").innerHTML=recipes.map(r=>`<div class="admin-recipe-row"><span><b>${escapeHtml(r.name)}</b><br><small class="hint">${r.minutes} мин. · ${r.portions} порц.</small></span><button class="btn btn-outline btn-small" data-edit-recipe="${r.id}">Изменить</button><button class="danger-btn" data-delete-recipe="${r.id}">Удалить</button></div>`).join("")||`<p class="hint">Рецептов пока нет.</p>`;
      $$("[data-edit-recipe]").forEach(b=>b.onclick=()=>openRecipeDialog(recipes.find(r=>r.id===b.dataset.editRecipe)));
      $$("[data-delete-recipe]").forEach(b=>b.onclick=async()=>{if(!confirm("Удалить этот рецепт? Он также исчезнет из меню, где использовался."))return;try{const {error}=await db.from("recipes").delete().eq("id",b.dataset.deleteRecipe);if(error)throw error;await refreshContent();await loadAdmin();toast("Рецепт удалён.");}catch(e){toast("Ошибка удаления: "+e.message)}});
    } catch(e) {
      $("#usersTable").innerHTML=`<tr><td colspan="4">Не удалось загрузить пользователей. Проверьте SQL-функции из supabase/schema.sql и права администратора.</td></tr>`;
      toast("Ошибка админ-панели: "+e.message);
    }
  }
  async function refreshContent() { await loadRecipes(); renderRecipes(); renderWeek(); }
  function openRecipeDialog(recipe=null) {
    if(profile?.role!=="admin"){toast("Добавлять и редактировать общие рецепты может только администратор.");return;}
    $("#recipeId").value=recipe?.id||"";$("#recipeName").value=recipe?.name||"";$("#recipeDescription").value=recipe?.description||"";
    $("#recipeMinutes").value=recipe?.minutes||30;$("#recipePortions").value=recipe?.portions||2;
    $("#recipeDialogTitle").textContent=recipe?"Редактировать рецепт":"Новый рецепт";setRecipeMessage("");$("#recipeDialog").showModal();
  }
  async function handleAuthSubmit(e) {
    e.preventDefault(); if(!db){setAuthMessage("Сначала укажите URL и ключ Supabase в js/config.js.");return;}
    const email=$("#email").value.trim(),password=$("#password").value;
    $("#authSubmit").disabled=true;setAuthMessage(isSignup?"Создаём аккаунт…":"Выполняем вход…");
    try {
      if(isSignup) {
        const {data,error}=await db.auth.signUp({email,password,options:{data:{display_name:$("#displayName").value.trim()}}});
        if(error)throw error;
        if(data.session){toast("Аккаунт создан.");}
        else {setAuthMessage("Регистрация начата. Проверьте почту для подтверждения, затем войдите.",true);return;}
      } else {
        const {error}=await db.auth.signInWithPassword({email,password});if(error)throw error;
      }
      const {data}=await db.auth.getSession();session=data.session;
      if(session)await enterSession();
    } catch(e) { setAuthMessage(e.message || "Не удалось выполнить операцию."); }
    finally { $("#authSubmit").disabled=false; }
  }
  async function enterSession() {
    if(!session){showLoggedOut();return;}
    try { await loadProfile(); await loadRecipes(); showLoggedIn(); await loadWeek(); renderRecipes(); renderShopping(); }
    catch(e) { toast("Не удалось загрузить профиль. Проверьте SQL-схему Supabase: "+e.message); await db.auth.signOut(); session=null;profile=null;showLoggedOut(); }
  }
  async function logout() { await db.auth.signOut();session=null;profile=null;recipes=[];showLoggedOut(); }
  async function saveRecipe(e) {
    e.preventDefault();setRecipeMessage("");
    if(profile?.role!=="admin"){setRecipeMessage("Недостаточно прав.");return;}
    const id=$("#recipeId").value;
    const payload={name:$("#recipeName").value.trim(),description:$("#recipeDescription").value.trim(),minutes:Number($("#recipeMinutes").value),portions:Number($("#recipePortions").value),created_by:session.user.id};
    try {
      const result=id ? await db.from("recipes").update(payload).eq("id",id).select().single() : await db.from("recipes").insert(payload).select().single();
      if(result.error)throw result.error;
      $("#recipeDialog").close();await refreshContent();if(profile.role==="admin")await loadAdmin();toast("Рецепт сохранён.");
    } catch(e) { setRecipeMessage(e.message || "Не удалось сохранить рецепт."); }
  }
  async function handleShopping(e) {
    e.preventDefault();const key=`shasaidovs-shopping-${session.user.id}`;let items=[];try{items=JSON.parse(localStorage.getItem(key)||"[]")}catch{}
    items.push({name:$("#shoppingInput").value.trim(),done:false});localStorage.setItem(key,JSON.stringify(items));$("#shoppingInput").value="";renderShopping();
  }
  async function init() {
    $("#loginTab").onclick=()=>setAuthMode(false);$("#signupTab").onclick=()=>setAuthMode(true);
    $("#authForm").onsubmit=handleAuthSubmit;$("#logoutBtn").onclick=logout;
    $$(".nav-btn").forEach(b=>b.onclick=()=>activateView(b.dataset.view));
    $("#saveWeekBtn").onclick=async()=>{try{await saveWeek()}catch(e){toast("Не удалось сохранить меню: "+e.message)}};
    $("#prevWeekBtn").onclick=async()=>{currentWeek--;try{await loadWeek()}catch(e){toast(e.message)}};
    $("#nextWeekBtn").onclick=async()=>{currentWeek++;try{await loadWeek()}catch(e){toast(e.message)}};
    $("#addRecipeBtn").onclick=()=>openRecipeDialog();
    $("#closeRecipeDialog").onclick=()=>$("#recipeDialog").close();
    $("#recipeForm").onsubmit=saveRecipe;$("#shoppingForm").onsubmit=handleShopping;
    $("#refreshUsersBtn").onclick=loadAdmin;
    if(!supabaseReady){showLoggedOut();setAuthMessage("Настройте js/config.js: вставьте Project URL и Publishable/anon key из Supabase.");return;}
    db=window.supabase.createClient(cfg.SUPABASE_URL,cfg.SUPABASE_ANON_KEY,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
    db.auth.onAuthStateChange((_event,newSession)=>{session=newSession;setTimeout(()=>{if(session&&!profile)enterSession();if(!session){profile=null;showLoggedOut();}},0)});
    const {data}=await db.auth.getSession();session=data.session;
    if(session)await enterSession();else showLoggedOut();
  }
  document.addEventListener("DOMContentLoaded",init);
})();