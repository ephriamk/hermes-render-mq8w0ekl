/* ECA Agent: the opening. Four lights (the four clubs) meet and form an emerald, drawn live,
   and the emerald speaks: its line is written out beneath it while its light beats with the words.
   Plays once per browser session, covers the blank seconds while the screen loads, and is
   skipped for anyone who asks their device for reduced motion or has no WebGL. Click or press
   a key to skip. Nothing here reads or sends any data except the person's own first name
   (/_eca/whoami) for the greeting. */
(function () {
  "use strict";
  try { if (sessionStorage.getItem("eca.intro") === "1") return; } catch (e) {}
  // A tab with no key for the workspace yet is about to be sent away for one (skin.js, first
  // lines, same test). Playing on that load would be cut off after a blink and would mark the
  // opening as seen (found 11-22), so wait for the load that stays.
  try {
    var KEY = "hermes.webapp.session.v1:" + JSON.stringify([location.origin, ""]);
    if (!sessionStorage.getItem(KEY) && Number(sessionStorage.getItem("eca.opentries") || 0) < 2) return;
  } catch (e) {}
  try { if (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) return; } catch (e) {}
  var cv = document.createElement("canvas");
  var gl = null;
  try { gl = cv.getContext("webgl", { antialias: false, alpha: false }); } catch (e) {}
  if (!gl) return;
  var VS = "attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}";
  var FS = `precision highp float;
uniform vec2 R;uniform float T;uniform float S;uniform vec4 P[42];
const int NPL=42;
mat3 rotY(float a){float c=cos(a),s=sin(a);return mat3(c,0.,-s,0.,1.,0.,s,0.,c);}
mat3 rotX(float a){float c=cos(a),s=sin(a);return mat3(1.,0.,0.,0.,c,s,0.,-s,c);}
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
float fbm(vec2 p){float a=.5,v=0.;for(int i=0;i<4;i++){v+=a*noise(p);p*=2.03;a*=.5;}return v;}
// the room the gem reflects: a dark studio with soft lights and thin light strips
vec3 env(vec3 d){
  vec3 c=vec3(.004,.016,.012);
  c+=vec3(1.,1.,.96)*pow(max(dot(d,normalize(vec3(.55,.8,-.25))),0.),48.)*9.;
  c+=vec3(.25,1.,.62)*pow(max(dot(d,normalize(vec3(-.75,.35,-.4))),0.),22.)*5.;
  c+=vec3(.55,1.,.85)*pow(max(dot(d,normalize(vec3(.1,-.7,-.7))),0.),30.)*3.5;
  c+=vec3(.9,1.,.95)*pow(max(dot(d,normalize(vec3(-.2,.2,.95))),0.),16.)*1.6;
  float s=sin(d.x*11.+d.y*5.+d.z*3.);c+=vec3(.8,1.,.9)*smoothstep(.93,.99,s)*(.35+.65*max(d.y,0.))*1.4;
  float s2=sin(d.z*9.-d.y*7.);c+=vec3(.2,.9,.55)*smoothstep(.95,.995,s2)*.9;
  return c;}
bool enter(vec3 o,vec3 d,out float tN,out vec3 nN){
  tN=-1e9;float tF=1e9;nN=vec3(0.,1.,0.);
  for(int i=0;i<NPL;i++){float dn=dot(d,P[i].xyz),ds=P[i].w-dot(o,P[i].xyz);
    if(abs(dn)<1e-6){if(ds<0.)return false;}
    else{float t=ds/dn;if(dn<0.){if(t>tN){tN=t;nN=P[i].xyz;}}else{if(t<tF)tF=t;}}}
  return tN<tF&&tF>0.&&tN>0.;}
void leave(vec3 o,vec3 d,out float t,out vec3 n){
  t=1e9;n=vec3(0.,1.,0.);
  for(int i=0;i<NPL;i++){float dn=dot(d,P[i].xyz);if(dn>1e-5){float tt=(P[i].w-dot(o,P[i].xyz))/dn;if(tt<t){t=tt;n=P[i].xyz;}}}}
vec4 gem(vec3 ro,vec3 rd,float sc,mat3 M,mat3 Mi){
  vec3 o=M*(ro/sc),d=M*rd;float tN;vec3 nN;
  if(!enter(o,d,tN,nN))return vec4(0.);
  vec3 pe=o+d*tN;float cosi=clamp(dot(-d,nN),0.,1.);
  float F=.045+.955*pow(1.-cosi,5.);
  vec3 refl=env(Mi*reflect(d,nN));
  const float IOR=1.62;
  vec3 dir=refract(d,nN,1./IOR),p=pe-nN*1e-3,thr=vec3(1.),inside=vec3(0.);
  bool out_=false;
  for(int b=0;b<5;b++){
    float t;vec3 n;leave(p,dir,t,n);
    thr*=exp(-vec3(2.6,.22,1.45)*t*.85);
    vec3 hp=p+dir*t;
    vec3 g=refract(dir,-n,IOR);
    if(dot(g,g)>0.){
      vec3 r_=refract(dir,-n,IOR-.05),b_=refract(dir,-n,IOR+.05);
      vec3 e=env(Mi*g);
      if(dot(r_,r_)>0.)e.r=env(Mi*r_).r;
      if(dot(b_,b_)>0.)e.b=env(Mi*b_).b;
      inside+=thr*e;out_=true;break;}
    dir=reflect(dir,-n);p=hp-n*1e-3;}
  if(!out_)inside+=thr*vec3(.05,.5,.3);
  vec3 col=mix(inside*1.5+vec3(.0,.035,.02),refl,F);
  // crisp facet edges catch a little light
  return vec4(col,1.);}
float eob(float x){x=clamp(x,0.,1.);float c1=1.70158,c3=c1+1.;return 1.+c3*pow(x-1.,3.)+c1*pow(x-1.,2.);}
void main(){
  vec2 uv=(gl_FragCoord.xy-.5*R)/R.y;float t=T;
  float asp=R.x/R.y;
  vec3 col=vec3(0.);
  // deep emerald haze that wakes up as the gem forms
  float wake=smoothstep(1.1,2.6,t);
  float n=fbm(uv*1.6+vec2(t*.05,-t*.03));
  col+=vec3(.004,.03,.02)*n*(.2+wake)*exp(-dot(uv,uv)*1.4);
  // four clubs: four lights sweep in from the corners on curved paths
  float ct=clamp(t/1.32,0.,1.);
  for(int i=0;i<4;i++){
    vec2 c=vec2((i==0||i==2)?-1.:1.,(i<2)?1.:-1.)*vec2(asp*.5-.09,.41);
    float g=0.;
    for(int j=0;j<36;j++){
      float tt=clamp(ct-float(j)*.0085,0.,1.);
      float e=tt*tt*(3.-2.*tt);e=e*e*(3.-2.*e);
      float a=(1.-e)*1.9*((i==0||i==3)?1.:-1.);
      vec2 q=c*(1.-e);q=mat2(cos(a),-sin(a),sin(a),cos(a))*q;
      float dd=dot(uv-q,uv-q);
      g+=(.00016/(dd+.00006))*exp(-dd*55.)*pow(1.-float(j)/36.,1.6)*(j==0?3.:1.);}
    col+=vec3(.35,1.,.68)*g*smoothstep(0.,.12,t)*(1.-smoothstep(1.28,1.5,t));}
  // impact: a ring of light leaves the centre
  float it=t-1.3;
  if(it>0.){float r=it*1.9;float l=length(uv);
    col+=vec3(.55,1.,.8)*exp(-pow((l-r)*14.,2.))*exp(-it*2.6)*1.6;
    col+=vec3(.8,1.,.9)*exp(-l*l*90.)*exp(-it*5.)*3.;}
  // the emerald
  float fit=min(1.,asp*.82);
  float gs=eob((t-1.28)/.9)*step(1.28,t);
  float st=smoothstep(2.75,3.75,t);st=st*st*(3.-2.*st);
  float sc=mix(gs*.86*fit,.52*fit,st)*(1.+.03*S);
  vec2 off=vec2(0.,mix(0.,.09,st));
  if(gs>0.001){
    vec2 ug=uv-off;
    vec3 ro=vec3(0.,0.,-4.6),rd=normalize(vec3(ug,1.55));
    float a=t*.9+.6,b=.44+sin(t*.7)*.2;
    mat3 M=rotX(b)*rotY(a),Mi=rotY(-a)*rotX(-b);
    vec4 g=gem(ro,rd,sc,M,Mi);
    float l=length(ug);
    float ang=atan(ug.y,ug.x);
    float rays=pow(abs(sin(ang*6.+t*.5))*abs(sin(ang*11.-t*.35))+.02,2.4);
    float rayAmt=smoothstep(1.6,2.5,t)*(1.-st*.6)+S*.55*st;
    col+=vec3(.12,.75,.45)*rays*rayAmt*exp(-l*3.4)*.4;
    col+=vec3(.03,.32,.19)*exp(-l*l*(6.+st*9.))*gs*(.7+S*1.5);
    col=mix(col,g.rgb*(1.+S*.4),g.a);}
  col=1.-exp(-col*1.5);
  col=pow(col,vec3(.82));
  // fine grain so the dark never bands
  col+=(hash(gl_FragCoord.xy+t)-.5)*.012;
  gl_FragColor=vec4(col,1.);}`;
  function sh(type, src) {
    var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
  }
  var vs = sh(gl.VERTEX_SHADER, VS), fs = sh(gl.FRAGMENT_SHADER, FS);
  if (!vs || !fs) return;
  var pr = gl.createProgram(); gl.attachShader(pr, vs); gl.attachShader(pr, fs); gl.linkProgram(pr);
  if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) return;
  gl.useProgram(pr);
  var buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  var loc = gl.getAttribLocation(pr, "p"); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  // An emerald cut: a long octagon with two steps of facets above the girdle and two below.
  (function(){var P=[],rad=[1.0,.9,.7,.9,1.0,.9,.7,.9],D=Math.PI/180;
 function tier(e,rf,h){for(var k=0;k<8;k++){var a=k*45*D,ce=Math.cos(e*D),se=Math.sin(e*D),n=[Math.cos(a)*ce,se,Math.sin(a)*ce],r=rad[k]*rf;P.push(n[0],n[1],n[2],r*ce+h*se)}}
 P.push(0,1,0,.40);          // table
 tier(34,1.0,.07);tier(60,.74,.27);
 tier(0,1.0,0);              // girdle
 tier(-38,1.0,-.07);tier(-57,.62,-.42);
 P.push(0,-1,0,.82);         // culet
 gl.uniform4fv(gl.getUniformLocation(pr,"P"),new Float32Array(P))})();
  var uR = gl.getUniformLocation(pr, "R"), uT = gl.getUniformLocation(pr, "T"), uS = gl.getUniformLocation(pr, "S");

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; }
  var box = el("div"); box.id = "eca-intro"; box.setAttribute("aria-hidden", "true");
  box.appendChild(cv);
  [["Everett", "06902"], ["Wallingford", "06904"], ["Columbia", "40059"], ["Ballinger", "40054"]].forEach(function (c, i) {
    var s = el("span", "eca-intro-club c" + (i + 1), c[0]); s.appendChild(el("b", "", c[1])); box.appendChild(s);
  });
  var say = el("div", "eca-intro-say"); box.appendChild(say);
  var hr = new Date().getHours(), hello = hr < 12 ? "Good morning" : hr < 17 ? "Good afternoon" : "Good evening";
  var lines = [hello + ".", "What are we working on?"];
  document.documentElement.appendChild(box);
  try { sessionStorage.setItem("eca.intro", "1"); } catch (e) {}
  try {
    fetch("/_eca/whoami", { credentials: "same-origin", cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { var first = d && d.name ? String(d.name).trim().split(/\s+/)[0] : ""; if (first && !typed) lines[0] = hello + ", " + first + "."; })
      .catch(function () {});
  } catch (e) {}

  // The emerald speaks. Each line is written a letter at a time; every letter gives the stone a
  // beat of light (stronger on vowels), which the picture reads as S and lets fade.
  var SPEAK_AT = 3.05, PER = 0.034, GAP = 0.42, typed = 0, pulse = 0, rows = [], spoken = false, doneAt = 0;
  function speak(t) {
    if (t < SPEAK_AT) return;
    if (!rows.length) lines.forEach(function () { var r = el("div", "eca-intro-line"); say.appendChild(r); rows.push(r); });
    var at = SPEAK_AT, n = 0;
    for (var i = 0; i < lines.length; i++) {
      var want = Math.max(0, Math.min(lines[i].length, Math.floor((t - at) / PER)));
      if (rows[i].textContent.length !== want) {
        var ch = lines[i].charAt(want - 1);
        rows[i].textContent = lines[i].slice(0, want);
        if (want && /[a-z]/i.test(ch)) pulse = Math.max(pulse, /[aeiou]/i.test(ch) ? 1 : 0.6);
      }
      n += want; at += lines[i].length * PER + GAP;
    }
    typed = n;
    if (!spoken && t >= at - GAP) { spoken = true; doneAt = t; }
  }

  function size() {
    var d = Math.min(1.5, window.devicePixelRatio || 1), w = Math.round(cv.clientWidth * d), h = Math.round(cv.clientHeight * d);
    if (w < 2 || h < 2) return;
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    gl.viewport(0, 0, w, h); gl.uniform2f(uR, w, h);
  }
  var HOLD = 1.25, MAX = 12, t0 = 0, raf = 0, ended = false, last = 0;
  function ready() { return !!document.querySelector('p.wordmark,[data-slot="aui_thread-content"],li[data-slot="sidebar-menu-item"]'); }
  function end() {
    if (ended) return; ended = true;
    box.classList.add("eca-intro-out");
    setTimeout(function () { cancelAnimationFrame(raf); if (box.parentNode) box.parentNode.removeChild(box); }, 800);
    window.removeEventListener("keydown", end, true);
  }
  function frame(now) {
    if (!t0) { t0 = now; box.classList.add("eca-intro-run"); }
    var t = (now - t0) / 1000;
    speak(t);
    pulse *= Math.pow(0.0016, Math.min(0.1, (now - (last || now)) / 1000)); last = now;   // fades in about a sixth of a second
    size(); gl.uniform1f(uT, t); gl.uniform1f(uS, pulse); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (!ended && ((spoken && t >= doneAt + HOLD && ready()) || t >= MAX)) end();
    raf = requestAnimationFrame(frame);
  }
  box.addEventListener("click", end);
  window.addEventListener("keydown", end, true);
  raf = requestAnimationFrame(frame);
})();
