/* The ECA emerald: the assistant's character, as one self-contained piece any page can use.

   window.ECAEmerald.attach(canvas, { mode })   draw the emerald into a <canvas> (any size, square)
       mode "idle"      slow turn, gentle float, leans a little toward the pointer
       mode "thinking"  quick turn, light breathing fast
   window.ECAEmerald.beat(strength)             one beat of light (0..1), e.g. per word spoken
   window.ECAEmerald.say(el, text, done)        write text into el a letter at a time, beating with it

   One hidden WebGL canvas draws the stone once per frame; every attached canvas copies from it, so
   ten emeralds on a page cost the same as one. Drawing stops while the tab is hidden or nothing
   is attached. No images, no network, no data. Same cut and light as skin/intro.js (keep in step). */
(function () {
  "use strict";
  if (window.ECAEmerald) return;
  var VS = "attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}";
  var FS = `precision highp float;
uniform vec2 R;uniform float A;uniform float B;uniform float S;uniform float Y;uniform vec4 P[42];
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
void main(){
  vec2 uv=(gl_FragCoord.xy-.5*R)/R.y;uv.y-=Y;
  vec3 ro=vec3(0.,0.,-4.6),rd=normalize(vec3(uv,1.55));
  mat3 M=rotX(B)*rotY(A),Mi=rotY(-A)*rotX(-B);
  vec4 g=gem(ro,rd,1.42*(1.+.035*S),M,Mi);
  vec3 col=g.rgb*(1.+S*.45);
  col=1.-exp(-col*1.5);col=pow(col,vec3(.82));
  float l=length(uv);
  float halo=exp(-l*l*7.5)*(.30+.75*S)*(1.-g.a);
  gl_FragColor=vec4(col*g.a+vec3(.10,.92,.55)*halo*.6,g.a+halo*.6);}`;
  var eng = null, gl = null, U = {}, items = [], raf = 0, last = 0;
  var ang = 0.6, spin = 0.45, pulse = 0, lookX = 0, lookY = 0, tX = 0, tY = 0, clock = 0, dead = false;

  function build() {
    if (eng || dead) return !dead;
    try {
      eng = document.createElement("canvas");
      gl = eng.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false });
      if (!gl) throw 0;
      var sh = function (type, s) { var o = gl.createShader(type); gl.shaderSource(o, s); gl.compileShader(o);
        if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw 0; return o; };
      var pr = gl.createProgram(); gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(pr); if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw 0; gl.useProgram(pr);
      var buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      var loc = gl.getAttribLocation(pr, "p"); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      (function(){var P=[],rad=[1.0,.9,.7,.9,1.0,.9,.7,.9],D=Math.PI/180;
       function tier(e,rf,h){for(var k=0;k<8;k++){var a=k*45*D,ce=Math.cos(e*D),se=Math.sin(e*D),n=[Math.cos(a)*ce,se,Math.sin(a)*ce],r=rad[k]*rf;P.push(n[0],n[1],n[2],r*ce+h*se)}}
       P.push(0,1,0,.40);          // table
       tier(34,1.0,.07);tier(60,.74,.27);
       tier(0,1.0,0);              // girdle
       tier(-38,1.0,-.07);tier(-57,.62,-.42);
       P.push(0,-1,0,.82);         // culet
       gl.uniform4fv(gl.getUniformLocation(pr,"P"),new Float32Array(P))})();
      ["R", "A", "B", "S", "Y"].forEach(function (k) { U[k] = gl.getUniformLocation(pr, k); });
      gl.clearColor(0, 0, 0, 0);
      return true;
    } catch (e) { dead = true; eng = null; gl = null; return false; }
  }

  function frame(now) {
    raf = 0;
    items = items.filter(function (it) { return it.cv.isConnected; });
    if (!items.length) return;
    var dt = Math.min(0.05, (now - (last || now)) / 1000); last = now;
    var live = items.filter(function (it) { return it.cv.offsetParent !== null && it.cv.clientWidth > 0; });
    if (live.length && !document.hidden) {
      var thinking = live.some(function (it) { return it.mode === "thinking"; });
      spin += ((thinking ? 2.4 : 0.45) - spin) * Math.min(1, dt * 3);
      ang += dt * spin; clock += dt;
      pulse *= Math.pow(0.0016, dt);
      lookX += (tX - lookX) * Math.min(1, dt * 4); lookY += (tY - lookY) * Math.min(1, dt * 4);
      var breathe = thinking ? 0.35 + 0.35 * Math.sin(clock * 5.2) : 0.10 + 0.08 * Math.sin(clock * 1.4);
      var dpr = Math.min(2, window.devicePixelRatio || 1), want = 0;
      live.forEach(function (it) { want = Math.max(want, it.cv.clientWidth * dpr); });
      var size = Math.max(64, Math.min(640, Math.round(want * 1.5)));          // drawn larger, copied down: smooth edges
      if (eng.width !== size) { eng.width = size; eng.height = size; }
      gl.viewport(0, 0, size, size); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform2f(U.R, size, size); gl.uniform1f(U.A, ang + lookX * 0.5);
      gl.uniform1f(U.B, 0.44 + Math.sin(clock * 0.5) * 0.16 - lookY * 0.35);
      gl.uniform1f(U.S, Math.min(1.2, Math.max(pulse, breathe)));
      gl.uniform1f(U.Y, Math.sin(clock * 1.3) * 0.018);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      live.forEach(function (it) {
        var w = Math.round(it.cv.clientWidth * dpr);
        if (it.cv.width !== w) { it.cv.width = w; it.cv.height = w; }
        var c = it.ctx; c.clearRect(0, 0, w, w); c.imageSmoothingQuality = "high"; c.drawImage(eng, 0, 0, w, w);
      });
    }
    raf = requestAnimationFrame(frame);
  }
  function wake() { if (!raf && items.length) { last = 0; raf = requestAnimationFrame(frame); } }

  // The stone leans a little toward the pointer, so it seems to notice you.
  window.addEventListener("pointermove", function (e) {
    tX = (e.clientX / Math.max(1, window.innerWidth) - 0.5) * 2; tY = (e.clientY / Math.max(1, window.innerHeight) - 0.5) * 2;
  }, { passive: true });
  document.addEventListener("visibilitychange", function () { if (!document.hidden) wake(); });

  window.ECAEmerald = {
    attach: function (cv, opts) {
      if (!cv || cv.__ecaGem) return !!(cv && cv.__ecaGem);
      if (!build()) return false;
      var ctx = cv.getContext("2d"); if (!ctx) return false;
      cv.__ecaGem = true; items.push({ cv: cv, ctx: ctx, mode: (opts && opts.mode) || "idle" }); wake(); return true;
    },
    beat: function (v) { pulse = Math.max(pulse, Math.max(0, Math.min(1.2, v === undefined ? 1 : v))); },
    say: function (el, text, done) {
      var i = 0, self = this, t = String(text || "");
      el.textContent = "";
      (function step() {
        if (!el.isConnected) return;
        i += 1; el.textContent = t.slice(0, i);
        var ch = t.charAt(i - 1); if (/[a-z]/i.test(ch)) self.beat(/[aeiou]/i.test(ch) ? 1 : 0.6);
        if (i < t.length) setTimeout(step, /[.,!?]/.test(ch) ? 190 : 32); else if (done) done();
      })();
    }
  };
})();
