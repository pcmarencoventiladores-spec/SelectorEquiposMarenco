import React, { useState, useMemo, useEffect, useCallback } from "react";

/* ------------------------------------------------------------------ *
 * SELECTOR DE VENTILACIÓN GENERAL — naves industriales
 * Geometría de la nave en metros. Aire y equipo en unidades de
 * catálogo: CFM, in. w.g., in, FPM, HP.
 *
 * El motor de cálculo corre entero en el cliente. Ninguna cifra de
 * ingeniería la produce el modelo: la IA solo interpreta lenguaje
 * natural y redacta justificación sobre resultados ya calculados.
 *
 * Curvas de catálogo y cálculo a densidad estándar (0.075 lb/ft³).
 *
 * Para migrar a servidor propio: reemplazar llamarClaude() por un fetch
 * a tu endpoint (ej. POST /api/asistente), que es quien guarda la API
 * key y aplica autenticación y límite de llamadas por usuario.
 * ------------------------------------------------------------------ */

/* Valores de referencia. ACH típicos, tasas de aire exterior en CFM y
   Punto de partida editable: verificar contra la norma vigente del
   proyecto. */
const TIPOS = {
  banos: { nombre: "Baños o lavabos", min: 10, max: 15 },
  bodegas: { nombre: "Bodegas", min: 8, max: 10 },
  cocinas_comerciales: { nombre: "Cocinas comerciales o de escuela", min: 10, max: 15 },
  cocinas_domesticas: { nombre: "Cocinas domésticas", min: 10, max: 20 },
  calderas: { nombre: "Cuarto de calderas", min: 20, max: 30 },
  maquinas: { nombre: "Cuarto de máquinas o compresores", min: 20, max: 30 },
  fundiciones: { nombre: "Fundiciones", min: 20, max: 30 },
  hospitales: { nombre: "Hospitales", min: 4, max: 6 },
  laboratorios: { nombre: "Laboratorios", min: 4, max: 6 },
  lavanderias: { nombre: "Lavanderías", min: 20, max: 30 },
  naves_hornos: { nombre: "Naves de producción con hornos", min: 30, max: 60 },
  naves_pintura: { nombre: "Naves de producción con procesos de pintura", min: 30, max: 60 },
  naves_general: { nombre: "Naves de producción en general", min: 8, max: 15 },
  panaderias: { nombre: "Panaderías", min: 20, max: 30 },
  restaurantes: { nombre: "Restaurantes", min: 6, max: 10 },
  salones_baile: { nombre: "Salones de baile", min: 6, max: 8 },
  salones_reuniones: { nombre: "Salones para reuniones", min: 8, max: 12 },
  tintorerias: { nombre: "Tintorerías", min: 20, max: 30 },
};

const FT3_POR_M3 = 35.3147;
const FT2_POR_M2 = 10.7639;

/* El catálogo ya no viaja dentro del archivo: con el acceso cerrado,
   incrustarlo sería dejarlo a la vista de cualquiera que abra el código
   fuente. Se carga desde Supabase después de iniciar sesión. */
const CATALOGO_DEMO = [];


function interpolar(puntos, x, col) {
  if (x <= puntos[0][0]) return puntos[0][col];
  const last = puntos[puntos.length - 1];
  if (x >= last[0]) return last[col];
  for (let i = 0; i < puntos.length - 1; i++) {
    const p0 = puntos[i], p1 = puntos[i + 1];
    if (x >= p0[0] && x <= p1[0]) {
      const t = (x - p0[0]) / (p1[0] - p0[0]);
      return p0[col] + t * (p1[col] - p0[col]);
    }
  }
  return last[col];
}

/* Intersección de la curva del ventilador con la del sistema, p = k·Q² */
function puntoOperacion(curva, k) {
  const qMax = curva[curva.length - 1][0];
  const g = (q) => interpolar(curva, q, 1) - k * q * q;
  let lo = 0, hi = qMax;
  if (g(hi) > 0) return { q: hi, p: interpolar(curva, hi, 1), borde: true };
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (g(mid) > 0) lo = mid; else hi = mid;
  }
  const q = (lo + hi) / 2;
  return { q, p: k * q * q, borde: false };
}

const fmt = (n, d = 0) =>
  Number.isFinite(n)
    ? n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })
    : "—";

/* ------------------------------------------------------------------ *
 * Supabase
 *
 * La clave anon está pensada para vivir en el frontend: no da acceso a
 * nada por sí sola, quien manda es la política RLS del proyecto. La que
 * NUNCA debe salir del servidor es la service_role.
 *
 * Se accede por REST (PostgREST), sin el SDK, para no arrastrar
 * dependencias. Deja los valores vacíos y conéctate desde el panel de
 * catálogo si prefieres no tocar el código.
 * ------------------------------------------------------------------ */

const ENV = import.meta.env || {};
const SUPABASE_URL = ENV.VITE_SUPABASE_URL || "https://rsbjmunbljolbhhsdusk.supabase.co";
const SUPABASE_ANON_KEY = ENV.VITE_SUPABASE_ANON_KEY || "";
/* Endpoint propio que guarda la clave de Anthropic. Sin él, los dos
   botones de IA quedan desactivados: en un sitio estático no hay dónde
   esconder una clave, y ponerla en el navegador es regalarla. */
const IA_ENDPOINT = ENV.VITE_IA_ENDPOINT || "";
const IA_ACTIVA = Boolean(IA_ENDPOINT);

/* Prefijo vent_ para convivir con el resto del proyecto sin pisarlo. */
const VISTA_EQUIPOS = "vent_equipos_con_curva";

/* Las cuatro familias existen además como vistas propias en Supabase
   (vent_industriales, vent_comerciales, reci_industriales,
   reci_comerciales). La app lee la vista general y filtra en cliente,
   que con un catálogo de este tamaño es una sola petición en vez de
   cuatro. Para consultar una familia suelta: /rest/v1/vent_industriales */
const FAMILIAS = {
  vent_industriales: "Ventilación industrial",
  vent_comerciales: "Ventilación comercial",
  reci_industriales: "Recirculadores industriales",
  reci_comerciales: "Recirculadores comerciales",
};
/* Buckets del proyecto. Ojo con las mayúsculas: en la URL pública
   el nombre distingue capitalización, "Imagenes" no es "imagenes".
   Si en imagen_path guardas la URL completa, estos valores dejan de
   usarse: urlPublica() detecta el http y la deja pasar tal cual. */
const BUCKET_FOTOS = "Imagenes";
const BUCKET_CATALOGOS = "Imagenes";

function urlPublica(base, bucket, ruta) {
  if (!base || !ruta) return undefined;
  if (/^https?:\/\//i.test(ruta)) return ruta; // ya es una URL completa
  return `${base.replace(/\/$/, "")}/storage/v1/object/public/${bucket}/${ruta.replace(/^\//, "")}`;
}

async function cargarDesdeSupabase(base, clave, token) {
  const raiz = base.replace(/\/$/, "");
  const url = `${raiz}/rest/v1/${VISTA_EQUIPOS}?select=*&order=categoria.asc,modelo.asc&limit=2000`;
  const r = await fetch(url, {
    headers: { apikey: clave, Authorization: `Bearer ${token || clave}`, Accept: "application/json" },
  });
  if (!r.ok) {
    const detalle = await r.text().catch(() => "");
    const pistas = {
      401: "La sesión caducó. Vuelve a pedir el enlace de acceso.",
      403: `La política RLS no deja leer. Comprueba el grant select sobre ${VISTA_EQUIPOS}.`,
      404: `No existe la vista ${VISTA_EQUIPOS}. ¿Ejecutaste ya los scripts SQL?`,
    };
    throw new Error((pistas[r.status] || `Supabase respondió ${r.status}.`) +
      (detalle ? ` ${detalle.slice(0, 140)}` : ""));
  }
  const filas = await r.json();
  return filas
    .map((f) => ({
      marca: f.marca,
      modelo: f.modelo,
      categoria: f.categoria,
      tipo: f.tipo,
      diametro: f.diametro_in != null ? Number(f.diametro_in) : undefined,
      rpm: f.rpm != null ? Number(f.rpm) : undefined,
      foto: urlPublica(raiz, BUCKET_FOTOS, f.foto_path),
      fichaUrl: urlPublica(raiz, BUCKET_CATALOGOS, f.ficha_path),
      linea: f.linea,
      hp: f.hp != null ? Number(f.hp) : undefined,
      servicio: f.servicio,
      transmision: f.transmision,
      curva: (f.curva || [])
        .map((p) => [Number(p[0]), Number(p[1]), Number(p[2] ?? 0)])
        .filter((p) => p.every(Number.isFinite))
        .sort((a, b) => a[0] - b[0]),
    }))
    .filter((e) => e.curva.length >= 1);
}

/* ------------------------------ Sesión ------------------------------ *
 * Acceso por enlace al correo. No hay contraseña que guardar ni que
 * perder, y con create_user en false solo entra quien ya esté dado de
 * alta: si alguien pide acceso con un correo desconocido, no recibe
 * nada. Las altas se hacen desde el panel de Supabase.
 * ------------------------------------------------------------------- */

const ESTILOS = `
  .vs-acceso{--ink:#2b2f6e;--graf:#666;--mudo:#8a8a93;--rule:#dcdce2;--air:#ff8300;
    --air-txt:#a85700;--sig:#c62828;--sigsoft:#fbeaea;
    --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
    font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    background:#f2f2f5;color:var(--ink);min-height:100vh;display:flex;
    align-items:center;justify-content:center;padding:24px}
  .vs-acceso *{box-sizing:border-box}
  .vs-acceso-caja{background:#fff;border:1px solid var(--rule);border-radius:4px;
    padding:30px;max-width:400px;width:100%}
  .vs-acceso-caja h1{margin:0 0 14px;font-size:21px;font-weight:650;letter-spacing:-.02em}
  .vs-acceso-caja p{margin:0 0 14px;font-size:14px;color:var(--graf);line-height:1.55}
  .vs-acceso-pie{font-size:12px!important;color:var(--mudo)!important;margin:16px 0 0!important}
  .vs-acceso .vs-campo{display:flex;flex-direction:column;gap:4px}
  .vs-acceso .vs-lab{font-family:var(--mono);font-size:9.5px;letter-spacing:.09em;
    text-transform:uppercase;color:var(--mudo)}
  .vs-acceso input{width:100%;font-family:var(--mono);font-size:14px;padding:9px;
    border:1px solid var(--rule);border-radius:3px;background:#fcfcfd;color:var(--ink)}
  .vs-acceso input:focus-visible,.vs-acceso button:focus-visible{outline:2px solid var(--air);outline-offset:1px}
  .vs-acceso .vs-btn{font:inherit;font-size:13px;font-weight:550;padding:9px 16px;
    border-radius:3px;cursor:pointer;border:1px solid var(--ink);background:var(--ink);color:#fff}
  .vs-acceso .vs-btn.ghost{background:transparent;color:var(--ink)}
  .vs-acceso .vs-btn:disabled{opacity:.45;cursor:default}
  .vs-acceso .vs-err{background:var(--sigsoft);border-left:2px solid var(--sig);
    padding:8px 11px;border-radius:2px;font-size:12.5px;color:#8c1d1d;margin:10px 0 0}
`;

const CLAVE_SESION = "sv_sesion";

function leerSesion() {
  try {
    const s = JSON.parse(localStorage.getItem(CLAVE_SESION) || "null");
    if (s && s.access_token && s.expira > Date.now()) return s;
  } catch { /* almacenamiento no disponible o dato corrupto */ }
  return null;
}

function guardarSesion(s) {
  try { localStorage.setItem(CLAVE_SESION, JSON.stringify(s)); } catch { /* ignorado */ }
}

function borrarSesion() {
  try { localStorage.removeItem(CLAVE_SESION); } catch { /* ignorado */ }
}

async function entrar(email, password) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const cru = d.error_description || d.msg || d.message || "";
    // El servidor responde en inglés y con un mensaje deliberadamente vago,
    // para no revelar si el fallo es del correo o de la contraseña.
    if (/invalid login/i.test(cru)) throw new Error("Correo o contraseña incorrectos.");
    if (/email not confirmed/i.test(cru)) throw new Error("La cuenta aún no está confirmada. Revisa el correo de invitación.");
    if (/rate limit/i.test(cru)) throw new Error("Demasiados intentos seguidos. Espera un momento.");
    throw new Error(cru || `El servidor respondió ${r.status}`);
  }
  const sesion = {
    access_token: d.access_token,
    refresh_token: d.refresh_token || "",
    expira: Date.now() + (Number(d.expires_in || 3600) - 60) * 1000,
    correo: d.user?.email || email,
  };
  guardarSesion(sesion);
  return sesion;
}

function PantallaAcceso({ onEntrar }) {
  const [email, setEmail] = useState("");
  const [pass, setPass] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState("");

  const hacerEntrar = async () => {
    if (!email.trim() || !pass) return;
    setOcupado(true);
    setError("");
    try {
      onEntrar(await entrar(email.trim(), pass));
    } catch (e) {
      setError(e.message);
      setOcupado(false);
    }
  };

  return (
    <div className="vs-acceso">
      <div className="vs-acceso-caja">
        <h1>Selector de ventilación general</h1>
        <p>Introduce tus credenciales para acceder al catálogo.</p>

        <label className="vs-campo">
          <span className="vs-lab">Usuario<em>correo</em></span>
          <input type="email" value={email} autoComplete="username"
            placeholder="nombre@empresa.com"
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && hacerEntrar()} />
        </label>

        <label className="vs-campo" style={{ marginTop: 11 }}>
          <span className="vs-lab">Contraseña</span>
          <input type="password" value={pass} autoComplete="current-password"
            onChange={(e) => setPass(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && hacerEntrar()} />
        </label>

        {error && <p className="vs-err">{error}</p>}

        <button className="vs-btn" onClick={hacerEntrar}
          disabled={ocupado || !email.trim() || !pass} style={{ marginTop: 12 }}>
          {ocupado ? "Entrando…" : "Entrar"}
        </button>

        <p className="vs-acceso-pie">
          Las cuentas las da de alta el administrador. Si olvidas la contraseña,
          pídele que te la restablezca.
        </p>
      </div>
    </div>
  );
}

/* ---------------------------- IA ---------------------------- */

async function llamarClaude(system, mensaje) {
  if (!IA_ACTIVA) throw new Error("Sin endpoint de IA configurado.");
  const r = await fetch(IA_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ system, mensaje }),
  });
  if (!r.ok) throw new Error("El asistente no respondió (" + r.status + ")");
  const data = await r.json();
  return data.texto || "";
}

/* ---------------------------- UI base ---------------------------- */

function Campo({ etiqueta, unidad, valor, onChange, paso = 1, min = 0 }) {
  return (
    <label className="vs-campo">
      <span className="vs-lab">
        {etiqueta}
        {unidad && <em>{unidad}</em>}
      </span>
      <input
        type="number"
        value={valor}
        step={paso}
        min={min}
        onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
      />
    </label>
  );
}

function Panel({ titulo, indice, children, nota }) {
  return (
    <section className="vs-panel">
      <header>
        <span className="vs-idx">{indice}</span>
        <h2>{titulo}</h2>
      </header>
      <div className="vs-panel-body">{children}</div>
      {nota && <p className="vs-nota">{nota}</p>}
    </section>
  );
}

/* -------------------- vista isométrica de la nave -------------------- */
/* Proyección isométrica clásica a 30°. El eje x recorre el ancho, el eje y
   el largo y el eje z la altura. La escala se ajusta sola al encuadre. */

function NaveIso({ largo, ancho, hombro, cumbrera }) {
  const VW = 340, VH = 208;
  const M = { l: 42, r: 30, t: 24, b: 38 };
  const W = Math.max(ancho, 0.5), L = Math.max(largo, 0.5);
  const H1 = Math.max(hombro, 0.3), H2 = Math.max(cumbrera, H1);
  const c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6);
  const iso = (x, y, z) => [(x - y) * c, (x + y) * s - z];

  const V = {
    b00: iso(0, 0, 0), bW0: iso(W, 0, 0), bWL: iso(W, L, 0), b0L: iso(0, L, 0),
    e00: iso(0, 0, H1), eW0: iso(W, 0, H1), eWL: iso(W, L, H1), e0L: iso(0, L, H1),
    r0: iso(W / 2, 0, H2), rL: iso(W / 2, L, H2), bcL: iso(W / 2, L, 0),
  };
  const todos = Object.values(V);
  const xs = todos.map((p) => p[0]), ys = todos.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const dispW = VW - M.l - M.r, dispH = VH - M.t - M.b;
  const esc = Math.min(dispW / (maxX - minX || 1), dispH / (maxY - minY || 1));
  const ox = M.l + (dispW - (maxX - minX) * esc) / 2;
  const oy = M.t + (dispH - (maxY - minY) * esc) / 2;
  const P = (p) => [ox + (p[0] - minX) * esc, oy + (p[1] - minY) * esc];
  const pt = (k) => P(V[k]).map((n) => n.toFixed(1)).join(",");
  const cara = (...ks) => ks.map(pt).join(" ");

  const cota = (k1, k2, off, texto, clave, fuera = false) => {
    const A = P(V[k1]), B = P(V[k2]);
    const dx = B[0] - A[0], dy = B[1] - A[1];
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * off, ny = (dx / len) * off;
    const A2 = [A[0] + nx, A[1] + ny], B2 = [B[0] + nx, B[1] + ny];
    const mx = (A2[0] + B2[0]) / 2, my = (A2[1] + B2[1]) / 2;
    /* Dirección hacia fuera. Se divide por el valor absoluto: al usar el
       signo, un desplazamiento negativo invertía el sentido y el rótulo
       se metía hacia dentro del dibujo. */
    const ox = nx / Math.abs(off || 1), oy = ny / Math.abs(off || 1);
    const tx = fuera ? mx + ox * 11 : mx;
    const ty = fuera ? my + oy * 11 : my;
    const anchor = !fuera ? "middle" : ox < -0.3 ? "end" : ox > 0.3 ? "start" : "middle";
    return (
      <g className="vs-cota" key={clave}>
        <line x1={A[0]} y1={A[1]} x2={A2[0]} y2={A2[1]} />
        <line x1={B[0]} y1={B[1]} x2={B2[0]} y2={B2[1]} />
        <line x1={A2[0]} y1={A2[1]} x2={B2[0]} y2={B2[1]} />
        <text x={tx} y={ty} textAnchor={anchor} dominantBaseline="middle"
          className={fuera ? undefined : "vs-cota-halo"}>{texto}</text>
      </g>
    );
  };

  const cum = P(V.rL), base = P(V.bcL);

  return (
    <svg viewBox={`0 0 ${VW} ${VH}`} className="vs-nave" role="img"
      aria-label={`Vista isométrica de nave de ${largo} por ${ancho} metros, ${hombro} de altura al hombro y ${cumbrera} a la cumbrera`}>
      <polyline points={`${pt("b0L")} ${pt("b00")} ${pt("bW0")}`} className="vs-iso-oculto" />
      <line x1={P(V.b00)[0]} y1={P(V.b00)[1]} x2={P(V.e00)[0]} y2={P(V.e00)[1]} className="vs-iso-oculto" />

      <polygon points={cara("bW0", "bWL", "eWL", "eW0")} className="vs-iso-pared" />
      <polygon points={cara("b0L", "bWL", "eWL", "rL", "e0L")} className="vs-iso-gable" />
      <polygon points={cara("e00", "e0L", "rL", "r0")} className="vs-iso-techo-a" />
      <polygon points={cara("r0", "rL", "eWL", "eW0")} className="vs-iso-techo-b" />

      <line x1={base[0]} y1={base[1]} x2={cum[0]} y2={cum[1]} className="vs-iso-eje" />

      {cota("b0L", "bWL", 15, `${ancho} m`, "ancho")}
      {cota("bWL", "bW0", 15, `${largo} m`, "largo")}
      {cota("b0L", "e0L", -17, `${hombro} m`, "hombro", true)}
      {/* La cumbrera se rotula sobre el centro de su propia línea de
          altura, con halo, igual que el ancho y el largo. */}
      <g className="vs-cota">
        <text x={(base[0] + cum[0]) / 2} y={(base[1] + cum[1]) / 2}
          textAnchor="middle" dominantBaseline="middle" className="vs-cota-halo">
          {cumbrera} m
        </text>
      </g>
    </svg>
  );
}

/* -------------------- gráfico de curvas -------------------- */

function Curvas({ equipo, k, qReq, op }) {
  const W = 620, H = 400;
  const M = { t: 18, r: 18, b: 74, l: 62 };
  if (!equipo) return null;

  const qMaxCat = equipo.curva[equipo.curva.length - 1][0];
  const qMax = Math.max(qMaxCat, qReq * 1.15) * 1.02;
  const pMaxCat = Math.max(...equipo.curva.map((p) => p[1]));
  const pMax = Math.max(pMaxCat, k * qMax * qMax) * 1.12 || 1;

  const X = (q) => M.l + (q / qMax) * (W - M.l - M.r);
  const Y = (p) => H - M.b - (p / pMax) * (H - M.t - M.b);

  const dVent = equipo.curva
    .map((pt, i) => `${i ? "L" : "M"}${X(pt[0]).toFixed(1)},${Y(pt[1]).toFixed(1)}`)
    .join(" ");

  const pasos = 60;
  const dSist = Array.from({ length: pasos + 1 }, (_, i) => {
    const q = (qMax * i) / pasos;
    return `${i ? "L" : "M"}${X(q).toFixed(1)},${Y(k * q * q).toFixed(1)}`;
  }).join(" ");

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="vs-svg" role="img"
      aria-label="Curva del ventilador contra curva del sistema con punto de operación">
      {Array.from({ length: 6 }, (_, i) => {
        const p = (pMax * i) / 5;
        return (
          <g key={"p" + i}>
            <line x1={M.l} x2={W - M.r} y1={Y(p)} y2={Y(p)} className="vs-grid" />
            <text x={M.l - 8} y={Y(p) + 3.5} className="vs-tick" textAnchor="end">{fmt(p, 2)}</text>
          </g>
        );
      })}
      {Array.from({ length: 6 }, (_, i) => {
        const q = (qMax * i) / 5;
        return (
          <g key={"q" + i}>
            <line x1={X(q)} x2={X(q)} y1={M.t} y2={H - M.b} className="vs-grid" />
            <text x={X(q)} y={H - M.b + 16} className="vs-tick" textAnchor="middle">{fmt(q)}</text>
          </g>
        );
      })}

      <text x={M.l} y={H - M.b + 38} className="vs-axis">CAUDAL CFM</text>
      <text x={-(H / 2)} y={14} transform="rotate(-90)" className="vs-axis" textAnchor="middle">
        PRESIÓN in. w.g.
      </text>

      <path d={dSist} className="vs-sistema" />
      <path d={dVent} className="vs-ventilador" />

      <line x1={X(qReq)} x2={X(qReq)} y1={M.t} y2={H - M.b} className="vs-req" />

      {op && (
        <g>
          <line x1={M.l} x2={X(op.q)} y1={Y(op.p)} y2={Y(op.p)} className="vs-cruz" />
          <line x1={X(op.q)} x2={X(op.q)} y1={H - M.b} y2={Y(op.p)} className="vs-cruz" />
          <circle cx={X(op.q)} cy={Y(op.p)} r="6" className="vs-op-halo" />
          <circle cx={X(op.q)} cy={Y(op.p)} r="3.5" className="vs-op" />
          <text x={X(op.q) - 10} y={Y(op.p) - 12} className="vs-op-etq" textAnchor="end">
            {fmt(op.q)} CFM · {fmt(op.p, 2)} in. w.g.
          </text>
        </g>
      )}

      {/* Leyenda fuera del área de trazado: dentro chocaba con la
          marca del caudal requerido cuando ésta caía a la derecha. */}
      <g className="vs-leyenda" transform={`translate(${M.l},${H - M.b + 58})`}>
        <line x1="0" x2="22" y1="0" y2="0" className="vs-ventilador" />
        <text x="28" y="3.5">Ventilador</text>
        <line x1="104" x2="126" y1="0" y2="0" className="vs-sistema" />
        <text x="132" y="3.5">Sistema</text>
        <line x1="200" x2="222" y1="0" y2="0" className="vs-req" />
        <text x="228" y="3.5">Caudal requerido</text>
      </g>
    </svg>
  );
}

/* -------------------- ilustración esquemática -------------------- */

function Ilustracion({ tipo }) {
  if (tipo === "Centrífugo") {
    return (
      <svg viewBox="0 0 140 96" className="vs-ilu" role="img" aria-label="Ventilador centrífugo">
        <rect x="80" y="6" width="28" height="46" rx="2" className="vs-ilu-cuerpo" />
        <circle cx="58" cy="52" r="32" className="vs-ilu-cuerpo" />
        <circle cx="58" cy="52" r="17" className="vs-ilu-aspa" />
        <circle cx="58" cy="52" r="5" className="vs-ilu-cuerpo" />
        <path d="M94,6 L94,52" className="vs-ilu-det" />
        <rect x="22" y="84" width="72" height="7" rx="1.5" className="vs-ilu-cuerpo" />
        <path d="M94,4 L94,-2" className="vs-ilu-det" />
      </svg>
    );
  }
  if (tipo === "En línea") {
    return (
      <svg viewBox="0 0 140 96" className="vs-ilu" role="img" aria-label="Ventilador en línea">
        <rect x="24" y="26" width="92" height="44" rx="5" className="vs-ilu-cuerpo" />
        <rect x="18" y="19" width="9" height="58" rx="1.5" className="vs-ilu-cuerpo" />
        <rect x="113" y="19" width="9" height="58" rx="1.5" className="vs-ilu-cuerpo" />
        <circle cx="70" cy="48" r="14" className="vs-ilu-aspa" />
        <circle cx="70" cy="48" r="4" className="vs-ilu-cuerpo" />
        <path d="M32,38 L48,38 M42,34 L48,38 L42,42" className="vs-ilu-det" />
        <path d="M92,58 L108,58 M102,54 L108,58 L102,62" className="vs-ilu-det" />
        <rect x="52" y="77" width="36" height="6" rx="1.5" className="vs-ilu-cuerpo" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 140 96" className="vs-ilu" role="img" aria-label="Ventilador axial">
      <rect x="17" y="5" width="106" height="86" rx="6" className="vs-ilu-cuerpo" />
      <circle cx="70" cy="48" r="36" className="vs-ilu-cuerpo" />
      {[0, 60, 120, 180, 240, 300].map((a) => (
        <path key={a} d="M79,43 Q97,32 103,46 Q88,53 79,53 Z"
          transform={`rotate(${a} 70 48)`} className="vs-ilu-aspa" />
      ))}
      <circle cx="70" cy="48" r="11" className="vs-ilu-cuerpo" />
      <circle cx="70" cy="48" r="3.5" className="vs-ilu-det" />
      {[[24, 12], [116, 12], [24, 84], [116, 84]].map(([x, y]) => (
        <circle key={x + "" + y} cx={x} cy={y} r="2.6" className="vs-ilu-det" />
      ))}
    </svg>
  );
}

function MiniCurva({ curva }) {
  const W = 132, H = 40, M = 3;
  const qM = curva[curva.length - 1][0] || 1;
  const pM = Math.max(...curva.map((p) => p[1])) || 1;
  const d = curva
    .map((pt, i) => {
      const x = M + (pt[0] / qM) * (W - 2 * M);
      const y = H - M - (pt[1] / pM) * (H - 2 * M);
      return `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="vs-mini-curva" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

/* -------------------- descargas -------------------- */

function bajarArchivo(nombre, contenido, tipoMime) {
  const blob = new Blob([contenido], { type: tipoMime + ";charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function descargarFicha(eq, cand, qReq) {
  const l = [
    "Ficha tecnica",
    `Marca,${eq.marca || ""}`,
    `Modelo,${eq.modelo}`,
    `Tipo,${eq.tipo || ""}`,
    `Diametro (in),${eq.diametro || ""}`,
    `Linea,${eq.linea || ""}`,
    `Potencia nominal (HP),${eq.hp ?? ""}`,
    `Servicio,${eq.servicio || ""}`,
    `Transmision,${eq.transmision || ""}`,
    "",
    "Curva caracteristica",
    "Caudal (CFM),Presion (in. w.g.),Potencia (HP)",
    ...eq.curva.map((p) => p.join(",")),
  ];
  if (cand && qReq > 0) {
    l.push(
      "",
      cand.sinCurva ? "Sin curva: solo caudal a descarga libre" : "Punto de operacion en este proyecto",
      `Caudal de diseno (CFM),${qReq.toFixed(0)}`,
      cand.sinCurva
        ? `Caudal a descarga libre (CFM),${cand.qLibre.toFixed(0)}`
        : `Caudal de operacion (CFM),${cand.op.q.toFixed(0)}`,
      cand.sinCurva ? "Presion de operacion,no determinable"
        : `Presion de operacion (in. w.g.),${cand.op.p.toFixed(3)}`,
      `ppm de cara (ft/min),${cand.cara.toFixed(1)}`,
      `Potencia nominal (HP),${cand.potencia.toFixed(2)}`,
      `Holgura (%),${cand.holgura.toFixed(1)}`
    );
  }
  if (cand?.sinCurva) {
    l.push("", "AVISO,El caudal a descarga libre es el techo del equipo. Con el sistema conectado entrega menos.");
  }
  bajarArchivo(`ficha-${eq.modelo}.csv`, l.join("\n"), "text/csv");
}

function descargarCatalogo(catalogo) {
  bajarArchivo("catalogo-ventiladores.json", JSON.stringify(catalogo, null, 2), "application/json");
}

/* Convierte el catálogo cargado en sentencias listas para el SQL Editor
   de Supabase. Reejecutar actualiza, no duplica. */
function descargarSQL(catalogo) {
  const q = (v) => (v == null ? "null" : `'${String(v).replace(/'/g, "''")}'`);
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : "null");
  const bloques = catalogo.map((e) => {
    const slug = String(e.modelo).toLowerCase().replace(/[^a-z0-9-]+/g, "-");
    const puntos = e.curva
      .map((p) => `  (${n(p[0])}::numeric, ${n(p[1])}::numeric, ${n(p[2])}::numeric)`)
      .join(",\n");
    return `with eq as (
  insert into public.vent_equipos (marca, modelo, categoria, tipo, diametro_in, rpm, foto_path, ficha_path)
  values (${q(e.marca || "Sin marca")}, ${q(e.modelo)}, ${q(e.categoria || "vent_industriales")}, ${q(e.tipo || "Axial")}, ${n(e.diametro)}, ${n(e.rpm)}, ${q(`${slug}.jpg`)}, ${q(`${slug}.pdf`)})
  on conflict (marca, modelo) do update
    set categoria = excluded.categoria, tipo = excluded.tipo,
        diametro_in = excluded.diametro_in, rpm = excluded.rpm
  returning id
), limpieza as (
  delete from public.vent_curva_puntos where equipo_id = (select id from eq)
)
insert into public.vent_curva_puntos (equipo_id, caudal_cfm, presion_inwg, potencia_hp)
select (select id from eq), * from (values
${puntos}
) as v(caudal, presion, potencia);`;
  });
  const cab = `-- Catálogo exportado desde el selector de ventilación\n-- Ejecutar en el SQL Editor de Supabase, después del esquema.\n-- Revisa foto_path y ficha_path: apuntan a rutas dentro de los buckets.\n\n`;
  bajarArchivo("catalogo-supabase.sql", cab + bloques.join("\n\n") + "\n", "text/plain");
}

/* -------------------- página de equipos -------------------- */

function PaginaEquipos({ catalogo, candidatos, qReq, elegido, onElegir, onDemo, esDemo }) {
  const [familia, setFamilia] = useState("todas");
  const [filtro, setFiltro] = useState("todos");
  const [linea, setLinea] = useState("todas");

  const familias = Array.from(new Set(catalogo.map((e) => e.categoria).filter(Boolean)));
  const tipos = ["todos", ...Array.from(new Set(catalogo.map((e) => e.tipo).filter(Boolean)))];

  /* Las líneas se calculan sobre lo que dejan pasar los otros dos filtros,
     así el desplegable nunca ofrece una opción que vaciaría la vista. */
  const previa = candidatos.filter(
    (c) =>
      (familia === "todas" || c.categoria === familia) &&
      (filtro === "todos" || c.tipo === filtro)
  );
  const lineas = Array.from(new Set(previa.map((c) => c.linea).filter(Boolean))).sort();
  const lista =
    linea === "todas" || !lineas.includes(linea)
      ? previa
      : previa.filter((c) => c.linea === linea);

  return (
    <div className="vs-equipos">
      {familias.length > 1 && (
        <div className="vs-filtros vs-filtros-fam">
          <button className={"vs-chip" + (familia === "todas" ? " on" : "")}
            onClick={() => setFamilia("todas")} aria-pressed={familia === "todas"}>
            Todas
          </button>
          {familias.map((f) => (
            <button key={f} className={"vs-chip" + (familia === f ? " on" : "")}
              onClick={() => setFamilia(f)} aria-pressed={familia === f}>
              {FAMILIAS[f] || f}
            </button>
          ))}
        </div>
      )}

      <div className="vs-filtros">
        {tipos.map((t) => (
          <button key={t} className={"vs-chip" + (filtro === t ? " on" : "")}
            onClick={() => setFiltro(t)} aria-pressed={filtro === t}>
            {t === "todos" ? "Todos" : t}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <label className="vs-campo" style={{ maxWidth: 160 }}>
          <span className="vs-lab">Línea</span>
          <select value={lineas.includes(linea) ? linea : "todas"}
            onChange={(e) => setLinea(e.target.value)}>
            <option value="todas">Todas ({previa.length})</option>
            {lineas.map((l) => (
              <option key={l} value={l}>
                {l} ({previa.filter((c) => c.linea === l).length})
              </option>
            ))}
          </select>
        </label>
      </div>

      {lista.length === 0 ? (
        <p className="vs-vacio">Ningún equipo del catálogo pasa este filtro. Amplía el criterio o carga más modelos.</p>
      ) : (
        <div className="vs-cards">
          {lista.map((c) => (
            <article key={c.idx} className={"vs-card" + (c.idx === elegido ? " on" : "")}>
              <div className="vs-card-img">
                {c.foto ? (
                  <img src={c.foto} alt={`${c.marca || ""} ${c.modelo}`} loading="lazy" />
                ) : (
                  <Ilustracion tipo={c.tipo} />
                )}
              </div>
              <div className="vs-card-body">
                <div className="vs-card-top">
                  <div>
                    <h3>{c.modelo}</h3>
                    <p className="vs-card-sub">
                      {[c.marca, c.linea, c.tipo, c.servicio].filter(Boolean).join(" · ")}
                    </p>
                    {c.categoria && (
                      <p className="vs-card-fam">{FAMILIAS[c.categoria] || c.categoria}</p>
                    )}
                  </div>
                </div>

                <dl className="vs-specs">
                  <div><dt>Ø</dt><dd>{c.diametro ? c.diametro + "″" : "—"}</dd></div>
                  <div><dt>{c.hp != null ? "HP" : "rpm"}</dt>
                    <dd>{c.hp != null ? c.hp : c.rpm ? fmt(c.rpm) : "—"}</dd></div>
                  <div><dt>Caudal máximo</dt><dd>{fmt(c.curva[c.curva.length - 1][0])}</dd></div>
                </dl>

                <MiniCurva curva={c.curva} />

                {c.sinCurva && (
                  <p className="vs-card-op">
                    Descarga libre <b>{fmt(c.qLibre)} CFM</b>
                  </p>
                )}

                <div className="vs-card-acc">
                  {!c.esRecirculador && (
                    <button className="vs-btn" onClick={() => onElegir(c.idx)}>
                      {c.idx === elegido ? "En uso" : "Usar en el selector"}
                    </button>
                  )}
                  {c.fichaUrl ? (
                    <a className="vs-btn ghost" href={c.fichaUrl} target="_blank" rel="noreferrer">
                      Catálogo
                    </a>
                  ) : (
                    <span className="vs-sin-pdf" title="Este equipo no tiene catálogo cargado">
                      Sin catálogo
                    </span>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

/* -------------------- selector de recirculación -------------------- */
/* Alcance de un recirculador de techo: entre 5 y 7 veces su diámetro,
   medido como el lado del cuadrado que cubre. De ahí salen un área
   máxima y una mínima por unidad, y con ellas el rango de unidades
   que necesita el recinto. */

const ALCANCE_MIN = 5;
const ALCANCE_MAX = 7;
const M_POR_PULGADA = 0.0254;

/* Reparte n equipos en filas por el ancho y columnas por el largo,
   buscando la malla exacta cuyo aspecto más se parezca al del recinto.
   Si n es primo sale una sola fila, que es lo correcto. */
function divisores(n) {
  const d = [];
  for (let i = 1; i <= n; i++) if (n % i === 0) d.push(i);
  return d;
}

function malla(n, largo, ancho) {
  const objetivo = Math.log((largo || 1) / (ancho || 1));
  let mejor = { filas: 1, columnas: Math.max(1, n) };
  let err = Infinity;
  for (let f = 1; f <= n; f++) {
    if (n % f) continue;
    const c = n / f;
    /* La desviación se mide en logaritmo: así 1×5 y 5×1 se comparan
       de forma simétrica. En escala lineal, 5×1 salía ganador en una
       nave alargada, que es justo al revés de lo que toca. */
    const e = Math.abs(Math.log(c / f) - objetivo);
    if (e < err) { err = e; mejor = { filas: f, columnas: c }; }
  }
  return mejor;
}

function EsquemaNave({ modo, span: spanNave, hombro = 6, cumbrera = 8.5,
                       ladoMin, ladoMax, n = 1 }) {
  const VW = 640, VH = 300;
  const M = { l: 30, r: 30, t: 26, b: 74 };
  const L = Math.max(Number(spanNave) || 1, 1);
  const H1 = Math.max(Number(hombro) || 6, 0.5);
  const H2 = Math.max(Number(cumbrera) || H1, H1);
  const uds = Math.max(1, Math.round(n));

  const span = Math.max(L, ladoMax) * 1.06;
  const esc = Math.min((VW - M.l - M.r) / span, (VH - M.t - M.b) / (H2 * 1.15));
  const cx = VW / 2, suelo = VH - M.b;
  const X = (m) => cx + m * esc;
  const Y = (m) => suelo - m * esc;
  const hVent = H2 * 0.82;

  // Un equipo en el centro de cada tramo: reparto uniforme sobre el vano
  const pos = Array.from({ length: uds }, (_, i) => -L / 2 + (L * (i + 0.5)) / uds);
  const zona = (c, lado, clase) => (
    <path key={clase + c} className={clase}
      d={`M${X(c)},${Y(hVent)} L${X(c + lado / 2)},${suelo} L${X(c - lado / 2)},${suelo} Z`} />
  );
  const cota = (c, lado, y, texto, clase) => (
    <g className="vs-cota" key={texto + c}>
      <line x1={X(c - lado / 2)} y1={y - 4} x2={X(c - lado / 2)} y2={y + 4} />
      <line x1={X(c + lado / 2)} y1={y - 4} x2={X(c + lado / 2)} y2={y + 4} />
      <line x1={X(c - lado / 2)} y1={y} x2={X(c + lado / 2)} y2={y} className={clase} />
      <text x={X(c)} y={y + 13} textAnchor="middle">{texto}</text>
    </g>
  );

  const frontal = modo === "frontal";
  const ancho1 = Math.max(9, Math.min(26, (L / uds) * esc * 0.34));

  return (
    <svg viewBox={`0 0 ${VW} ${VH}`} className="vs-nave" role="img"
      aria-label={`Vista ${frontal ? "frontal" : "lateral"} con ${uds} ${uds === 1 ? "equipo" : "equipos"}, alcance de ${ladoMin.toFixed(1)} a ${ladoMax.toFixed(1)} metros`}>
      {pos.map((c) => zona(c, ladoMax, "vs-zona-max"))}
      {pos.map((c) => zona(c, ladoMin, "vs-zona-min"))}

      {frontal ? (
        <>
          {/* Fachada longitudinal: la cumbrera corre paralela a la vista */}
          <line x1={X(-L / 2)} y1={Y(H2)} x2={X(L / 2)} y2={Y(H2)} className="vs-iso-oculto" />
          <line x1={X(-L / 2)} y1={Y(H2)} x2={X(-L / 2)} y2={Y(H1)} className="vs-iso-oculto" />
          <line x1={X(L / 2)} y1={Y(H2)} x2={X(L / 2)} y2={Y(H1)} className="vs-iso-oculto" />
          <path className="vs-fachada"
            d={`M${X(-L / 2)},${suelo} L${X(-L / 2)},${Y(H1)} L${X(L / 2)},${Y(H1)} L${X(L / 2)},${suelo}`} />
        </>
      ) : (
        /* Sección transversal: aquí sí se ve el caballete */
        <path className="vs-fachada"
          d={`M${X(-L / 2)},${suelo} L${X(-L / 2)},${Y(H1)} L${cx},${Y(H2)} L${X(L / 2)},${Y(H1)} L${X(L / 2)},${suelo}`} />
      )}
      <line x1={X(-span / 2)} y1={suelo} x2={X(span / 2)} y2={suelo} className="vs-suelo-l" />

      {pos.map((c, i) => (
        <g key={"eq" + i}>
          <line x1={X(c)} y1={Y(frontal ? H2 : H2 - Math.abs(c) * ((H2 - H1) / (L / 2)))}
            x2={X(c)} y2={Y(hVent)} className="vs-iso-eje" />
          <rect x={X(c) - ancho1} y={Y(hVent) - 3} width={ancho1 * 2} height="6" rx="2" className="vs-equipo" />
          <circle cx={X(c)} cy={Y(hVent)} r="4.5" className="vs-equipo" />
        </g>
      ))}

      {cota(pos[0], ladoMax, suelo + 16, `máximo ${ladoMax.toFixed(1)} m`, "vs-cl-max")}
      {cota(pos[0], ladoMin, suelo + 34, `mínimo ${ladoMin.toFixed(1)} m`, "vs-cl-min")}

      {/* Rótulo en el margen superior: dentro del dibujo chocaba con los
          equipos, que cuelgan a una altura próxima a la del hombro. */}
      <g className="vs-cota">
        <text x="6" y="15">
          {frontal ? `largo ${spanNave} m` : `ancho ${spanNave} m`} · {uds}{" "}
          {uds === 1 ? "equipo" : "equipos"} · cada {(L / uds).toFixed(1)} m
        </text>
      </g>
    </svg>
  );
}

/* Vista en planta: la malla de equipos sobre la superficie del recinto.
   Cada unidad cubre un cuadrado cuyo lado es su alcance, así que aquí se
   ve directamente si la distribución deja huecos o si los solapes son
   excesivos, cosa que en las vistas de alzado no se aprecia. */
function PlantaNave({ largo, ancho, filas, columnas, ladoMin, ladoMax }) {
  const VW = 640, VH = 420;
  const M = { l: 54, r: 26, t: 26, b: 52 };
  const L = Math.max(Number(largo) || 1, 1);
  const A = Math.max(Number(ancho) || 1, 1);
  const f = Math.max(1, Math.round(filas)), c = Math.max(1, Math.round(columnas));

  /* Encuadre fijo: no depende del reparto, así el dibujo conserva el mismo
     tamaño al mover filas y columnas y se pueden comparar distribuciones.
     El peor caso es un equipo pegado al borde, cuyo alcance sobresale media
     anchura de cuadrado: por eso se suma el alcance máximo entero. */
  const spanL = (L + ladoMax) * 1.02;
  const spanA = (A + ladoMax) * 1.02;
  const esc = Math.min((VW - M.l - M.r) / spanL, (VH - M.t - M.b) / spanA);
  const cx = M.l + (VW - M.l - M.r) / 2;
  const cy = M.t + (VH - M.t - M.b) / 2;
  const X = (m) => cx + m * esc;
  const Y = (m) => cy + m * esc;

  const pos = [];
  for (let i = 0; i < f; i++)
    for (let j = 0; j < c; j++)
      pos.push([-L / 2 + (L * (j + 0.5)) / c, -A / 2 + (A * (i + 0.5)) / f]);

  const cuadro = (px, py, lado, clase, k) => (
    <rect key={clase + k} className={clase}
      x={X(px - lado / 2)} y={Y(py - lado / 2)}
      width={lado * esc} height={lado * esc} />
  );

  return (
    <svg viewBox={`0 0 ${VW} ${VH}`} className="vs-nave" role="img"
      aria-label={`Vista en planta con ${f * c} equipos en ${f} filas por ${c} columnas`}>
      <g className="vs-cota">
        <text x="6" y="15">
          planta {largo} × {ancho} m · {f * c} {f * c === 1 ? "equipo" : "equipos"} · {f} × {c}
        </text>
      </g>

      {pos.map(([px, py], k) => cuadro(px, py, ladoMax, "vs-zona-max", k))}
      {pos.map(([px, py], k) => cuadro(px, py, ladoMin, "vs-zona-min", k))}

      <rect className="vs-fachada" x={X(-L / 2)} y={Y(-A / 2)}
        width={L * esc} height={A * esc} />

      {/* Retícula de reparto: marca el tramo que atiende cada equipo */}
      {Array.from({ length: c - 1 }, (_, j) => (
        <line key={"v" + j} className="vs-iso-eje"
          x1={X(-L / 2 + (L * (j + 1)) / c)} x2={X(-L / 2 + (L * (j + 1)) / c)}
          y1={Y(-A / 2)} y2={Y(A / 2)} />
      ))}
      {Array.from({ length: f - 1 }, (_, i) => (
        <line key={"h" + i} className="vs-iso-eje"
          x1={X(-L / 2)} x2={X(L / 2)}
          y1={Y(-A / 2 + (A * (i + 1)) / f)} y2={Y(-A / 2 + (A * (i + 1)) / f)} />
      ))}

      {pos.map(([px, py], k) => (
        <g key={"eq" + k}>
          <circle cx={X(px)} cy={Y(py)} r="9" className="vs-planta-halo" />
          <circle cx={X(px)} cy={Y(py)} r="3.5" className="vs-equipo" />
        </g>
      ))}

      <g className="vs-cota">
        <line x1={X(-L / 2)} y1={Y(A / 2) + 16} x2={X(L / 2)} y2={Y(A / 2) + 16} />
        <line x1={X(-L / 2)} y1={Y(A / 2) + 12} x2={X(-L / 2)} y2={Y(A / 2) + 20} />
        <line x1={X(L / 2)} y1={Y(A / 2) + 12} x2={X(L / 2)} y2={Y(A / 2) + 20} />
        <text x={cx} y={Y(A / 2) + 16} textAnchor="middle" dominantBaseline="middle"
          className="vs-cota-halo">{largo} m</text>

        <line x1={X(-L / 2) - 16} y1={Y(-A / 2)} x2={X(-L / 2) - 16} y2={Y(A / 2)} />
        <line x1={X(-L / 2) - 20} y1={Y(-A / 2)} x2={X(-L / 2) - 12} y2={Y(-A / 2)} />
        <line x1={X(-L / 2) - 20} y1={Y(A / 2)} x2={X(-L / 2) - 12} y2={Y(A / 2)} />
        <text x={X(-L / 2) - 16} y={cy} textAnchor="middle" dominantBaseline="middle"
          className="vs-cota-halo">{ancho} m</text>
      </g>
    </svg>
  );
}

function PaginaRecirculacion({ catalogo, ancho, largo, hombro, cumbrera, onAncho, onLargo,
                              elegido, onElegir, unidades, onUnidades,
                              filasSel, onFilas }) {
  const equipos = catalogo.filter((e) => e.categoria === "reci_industriales" && e.diametro);
  const eq = equipos.find((e) => e.modelo === elegido) || equipos[0] || null;

  if (!eq) {
    return (
      <div className="vs-equipos">
        <p className="vs-vacio">
          No hay recirculadores industriales con diámetro en el catálogo cargado.
          Esta página solo trabaja con esa familia.
        </p>
      </div>
    );
  }

  const D = eq.diametro * M_POR_PULGADA;
  const ladoMin = ALCANCE_MIN * D;
  const ladoMax = ALCANCE_MAX * D;
  const areaMin = ladoMin * ladoMin;
  const areaMax = ladoMax * ladoMax;
  const areaTotal = Math.max(ancho, 0) * Math.max(largo, 0);
  const udMin = areaMax > 0 ? areaTotal / areaMax : 0;
  const udMax = areaMin > 0 ? areaTotal / areaMin : 0;
  const nAuto = Math.max(1, Math.ceil(udMin));
  const n = Math.max(1, Math.round(unidades ?? nAuto));
  /* El producto filas × columnas debe dar exactamente n, así que basta
     con guardar las filas: las columnas salen de la división. Solo se
     ofrecen divisores de n, con lo que el par siempre es coherente. */
  const auto = malla(n, largo, ancho);
  const filas = filasSel && n % filasSel === 0 ? filasSel : auto.filas;
  const columnas = n / filas;
  const opciones = divisores(n);
  const cubierto = n * areaMax;

  return (
    <div className="vs-wrap">
      <div>
        <Panel indice="R1" titulo="Recinto">
          <div className="vs-grid2">
            <Campo etiqueta="Ancho" unidad="m" paso={0.5} valor={ancho} onChange={onAncho} />
            <Campo etiqueta="Largo" unidad="m" paso={0.5} valor={largo} onChange={onLargo} />
          </div>
          <div className="vs-grid2" style={{ marginTop: 11 }}>
            <label className="vs-campo" style={{ gridColumn: "1 / -1" }}>
              <span className="vs-lab">Área de recirculación<em>m²</em></span>
              <input type="text" readOnly value={fmt(areaTotal, 1)} />
            </label>
          </div>
        </Panel>

        <Panel indice="R2" titulo="Recirculador industrial">
          <label className="vs-campo">
            <span className="vs-lab">Equipo</span>
            <select value={eq.modelo} onChange={(e) => onElegir(e.target.value)}>
              {equipos.map((e) => (
                <option key={e.modelo} value={e.modelo}>
                  {e.modelo} — {(e.diametro / 12).toFixed(0)} pies
                </option>
              ))}
            </select>
          </label>
          <div className="vs-grid2" style={{ marginTop: 11 }}>
            <label className="vs-campo">
              <span className="vs-lab">Diámetro<em>m</em></span>
              <input type="text" readOnly value={D.toFixed(2)} />
            </label>
            <label className="vs-campo">
              <span className="vs-lab">Diámetro<em>pies</em></span>
              <input type="text" readOnly value={(eq.diametro / 12).toFixed(0)} />
            </label>
          </div>
          <div className="vs-grid2" style={{ marginTop: 11 }}>
            <Campo etiqueta="Equipos a instalar" unidad="ud" paso={1} min={1}
              valor={n} onChange={onUnidades} />
            <label className="vs-campo">
              <span className="vs-lab">Área cubierta<em>m²</em></span>
              <input type="text" readOnly value={fmt(cubierto, 0)} />
            </label>
          </div>

          <div className="vs-grid2" style={{ marginTop: 11 }}>
            <label className="vs-campo">
              <span className="vs-lab">Filas<em>a lo ancho</em></span>
              <select value={filas} onChange={(e) => onFilas(Number(e.target.value))}>
                {opciones.map((f) => (
                  <option key={f} value={f}>{f} × {n / f}</option>
                ))}
              </select>
            </label>
            <label className="vs-campo">
              <span className="vs-lab">Columnas<em>a lo largo</em></span>
              <select value={columnas} onChange={(e) => onFilas(n / Number(e.target.value))}>
                {opciones.map((c) => (
                  <option key={c} value={c}>{n / c} × {c}</option>
                ))}
              </select>
            </label>
          </div>
        </Panel>

        <Panel indice="R3" titulo="Alcance por unidad"
          nota={`El alcance va de ${ALCANCE_MIN} a ${ALCANCE_MAX} veces el diámetro, y es el lado del cuadrado que cubre el equipo. Ese lado al cuadrado da el área efectiva.`}>
          <div className="vs-grid2">
            <label className="vs-campo">
              <span className="vs-lab">Lado mínimo<em>m</em></span>
              <input type="text" readOnly value={ladoMin.toFixed(2)} />
            </label>
            <label className="vs-campo">
              <span className="vs-lab">Lado máximo<em>m</em></span>
              <input type="text" readOnly value={ladoMax.toFixed(2)} />
            </label>
            <label className="vs-campo">
              <span className="vs-lab">Área mínima<em>m²</em></span>
              <input type="text" readOnly value={fmt(areaMin, 1)} />
            </label>
            <label className="vs-campo">
              <span className="vs-lab">Área máxima<em>m²</em></span>
              <input type="text" readOnly value={fmt(areaMax, 1)} />
            </label>
          </div>
        </Panel>
      </div>

      <div>
        <div className="vs-readout">
          <p className="vs-eyebrow">Unidades necesarias</p>
          <div className="vs-cifra">
            <b>{Math.ceil(udMin)}</b>
            <span>a</span>
            <b>{Math.ceil(udMax)}</b>
            <span>{Math.ceil(udMax) === 1 ? "unidad" : "unidades"}</span>
          </div>
          <p className="vs-req-eq">
            {eq.modelo} · {fmt(areaTotal, 0)} m² a cubrir · cada unidad alcanza entre{" "}
            {fmt(areaMin, 0)} y {fmt(areaMax, 0)} m²
          </p>
          <dl className="vs-mini">
            <div>
              <dt>Con alcance máximo</dt>
              <dd>{udMin.toFixed(2)} ud</dd>
            </div>
            <div>
              <dt>Con alcance mínimo</dt>
              <dd>{udMax.toFixed(2)} ud</dd>
            </div>
            <div>
              <dt>Diámetro</dt>
              <dd>{D.toFixed(2)} m</dd>
            </div>
            <div>
              <dt>Área del recinto</dt>
              <dd>{fmt(areaTotal, 0)} m²</dd>
            </div>
          </dl>
        </div>

        <Panel indice="R4" titulo="Vista en planta">
          <PlantaNave largo={largo} ancho={ancho} filas={filas} columnas={columnas}
            ladoMin={ladoMin} ladoMax={ladoMax} />
        </Panel>

        <Panel indice="R5" titulo="Fachada longitudinal">
          <EsquemaNave modo="frontal" span={largo} hombro={hombro} cumbrera={cumbrera}
            ladoMin={ladoMin} ladoMax={ladoMax} n={columnas} />
        </Panel>

        <Panel indice="R6" titulo="Sección transversal">
          <EsquemaNave modo="lateral" span={ancho} hombro={hombro} cumbrera={cumbrera}
            ladoMin={ladoMin} ladoMax={ladoMax} n={filas} />
          <div className="vs-aviso" style={{ background: "var(--airsoft)", borderColor: "var(--air)", color: "var(--air-txt)" }}>
            <span>i</span>
            <span>
              El cálculo pide de {Math.ceil(udMin)} a {Math.ceil(udMax)} unidades: la cifra
              baja supone que cada equipo rinde su alcance máximo, la alta que rinde el
              mínimo. Con {n} {n === 1 ? "equipo" : "equipos"} quedan cubiertos hasta{" "}
              {fmt(cubierto, 0)} m² de los {fmt(areaTotal, 0)} m² del recinto. Con techos
              altos, obstrucciones o mucha carga térmica, acércate a la cifra alta.
            </span>
          </div>
        </Panel>
      </div>
    </div>
  );
}

/* ---------------------------- app ---------------------------- */

export default function SelectorVentilacion() {
  const [sesion, setSesion] = useState(leerSesion);
  const [vista, setVista] = useState("selector");
  const [recirEq, setRecirEq] = useState(null);
  const [recirUds, setRecirUds] = useState(null);
  const [recirFilas, setRecirFilas] = useState(null);
  const [tipo, setTipo] = useState("naves_general");
  const [dim, setDim] = useState({ largo: 30, ancho: 18, hombro: 6, cumbrera: 8.5 });
  const [ach, setAch] = useState(TIPOS.naves_general.min);

  const [presion, setPresion] = useState(0);

  const [catalogo, setCatalogo] = useState(CATALOGO_DEMO);
  const [conf, setConf] = useState({ url: SUPABASE_URL, clave: SUPABASE_ANON_KEY });
  const [origen, setOrigen] = useState("demo");
  const [cargandoCat, setCargandoCat] = useState(false);
  const [errCat, setErrCat] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [jsonTexto, setJsonTexto] = useState("");
  const [errImport, setErrImport] = useState("");

  const [elegido, setElegido] = useState(null);        // extracción
  const [elegidoIny, setElegidoIny] = useState(null);  // inyección
  const [manualExt, setManualExt] = useState(null);
  const [manualIny, setManualIny] = useState(null);
  const [servicio, setServicio] = useState("extraccion");
  const [lineaFiltro, setLineaFiltro] = useState("todas");

  const [descripcion, setDescripcion] = useState("");
  const [interpretando, setInterpretando] = useState(false);
  const [errIA, setErrIA] = useState("");
  const [memoria, setMemoria] = useState("");
  const [redactando, setRedactando] = useState(false);

  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

  const cambiarTipo = (t) => {
    setTipo(t);
    setAch(TIPOS[t].min);
  };

  const conectarSupabase = useCallback(async (url, clave, token) => {
    if (!url || !clave) return;
    setCargandoCat(true);
    setErrCat("");
    try {
      const equipos = await cargarDesdeSupabase(url, clave, token);
      if (!equipos.length) throw new Error("La consulta no devolvió ningún equipo utilizable.");
      setCatalogo(equipos);
      setOrigen("supabase");
      setElegido(null);
    } catch (e) {
      setErrCat(
        /fetch|network|Failed to fetch|load failed/i.test(e.message)
          ? "No hubo respuesta de Supabase. Puede ser la URL, o la política de seguridad del entorno de vista previa, que bloquea peticiones a dominios externos. Servido desde tu propia aplicación no ocurre."
          : e.message
      );
    } finally {
      setCargandoCat(false);
    }
  }, []);

  /* En cuanto hay sesión se trae el catálogo. Sin ella no se pide nada:
     el servidor lo rechazaría de todos modos. */
  useEffect(() => {
    if (sesion && SUPABASE_URL && SUPABASE_ANON_KEY) {
      conectarSupabase(SUPABASE_URL, SUPABASE_ANON_KEY, sesion.access_token);
    }
  }, [conectarSupabase, sesion]);

  const salir = () => { borrarSesion(); setSesion(null); setCatalogo([]); setOrigen("demo"); };

  const calc = useMemo(() => {
    const area = num(dim.largo) * num(dim.ancho);
    const hHombro = num(dim.hombro);
    const hCumbrera = Math.max(num(dim.cumbrera), hHombro);
    const hMedia = (hHombro + hCumbrera) / 2; // cubierta a dos aguas simétrica
    const volumen = area * hMedia; // m³
    const volumenFt3 = volumen * FT3_POR_M3;

    const qReq = (volumenFt3 * num(ach)) / 60; // CFM por renovaciones de aire

    /* Secciones transversales de la nave, en ft².
       A lo largo: plano vertical paralelo al eje longitudinal.
       A lo ancho: plano de la fachada de hastial. */
    const areaLargoFt2 = num(dim.largo) * hMedia * FT2_POR_M2;
    const areaAnchoFt2 = num(dim.ancho) * hMedia * FT2_POR_M2;
    const ppmLargo = areaLargoFt2 > 0 ? qReq / 2 / areaLargoFt2 : 0;
    const ppmCara = areaAnchoFt2 > 0 ? qReq / areaAnchoFt2 : 0;

    const pEst = num(presion);
    const k = qReq > 0 ? pEst / (qReq * qReq) : 0;

    /* Los recirculadores se calculan igual que el resto, pero se marcan:
       el selector los excluye porque no vencen presión estática, y cortar
       su curva con la del sistema no significaría nada. En la pestaña de
       Equipos siguen visibles, solo para consulta. Se detectan por prefijo
       y no por lista blanca, para que un catálogo importado sin categoría
       siga apareciendo. */
    const candidatos = catalogo
      .map((eq, i) => {
        const qMaxCat = eq.curva[eq.curva.length - 1][0];
        /* Con menos de tres puntos no hay curva que cortar con la del
           sistema. El último punto es el caudal a descarga libre, que
           es el techo absoluto del equipo: sirve para descartar, no
           para confirmar. */
        const sinCurva = eq.curva.length < 3;
        const qLibre = qMaxCat;
        const op = sinCurva ? null : puntoOperacion(eq.curva, k);
        const qRef = sinCurva ? qLibre : op.q;
        const potencia = sinCurva ? eq.curva[0][2] : interpolar(eq.curva, op.q, 2);
        const holgura = qReq > 0 ? (qRef / qReq - 1) * 100 : 0; // de una sola unidad
        const cara = areaAnchoFt2 > 0 ? qRef / areaAnchoFt2 : 0; // por unidad

        /* Cuántas unidades hacen falta y qué caudal queda instalado.
           Con extractores independientes los caudales se suman, así que
           lo que distingue a un equipo de otro no es si una unidad basta,
           sino cuántas necesita y cuánto sobra al final. */
        /* Unidades exactas, sin redondear, para poder decidir a mano si
           conviene bajar a la cifra inferior. El conteo redondea siempre
           hacia arriba: no se admite déficit. */
        const exactas = qRef > 0 ? qReq / qRef : 0;
        const unidades = qRef > 0 ? Math.max(1, Math.ceil(exactas)) : 0;
        const instalado = unidades * qRef;
        const superavit = qReq > 0 ? (instalado / qReq - 1) * 100 : 0;
        const superavitCfm = instalado - qReq;
        const hpTotal = eq.hp ? unidades * eq.hp : null;

        const estado = sinCurva ? "indeterminado" : "cumple";

        const avisos = [];
        if (!sinCurva && eq.tipo === "Axial" && op.q < 0.4 * qMaxCat)
          avisos.push("Punto en zona izquierda de la curva: riesgo de inestabilidad");
        if (!sinCurva && superavit > 40)
          avisos.push(`Sobran ${Math.round(superavitCfm).toLocaleString("en-US")} CFM, un ${superavit.toFixed(0)}% de más: considerar un equipo menor o regular el caudal`);

        const esRecirculador = String(eq.categoria || "").startsWith("reci_");
        return { ...eq, idx: i, esRecirculador, op, qLibre, qRef, sinCurva, estado, unidades, exactas,
                 instalado, superavit, superavitCfm, hpTotal, potencia, holgura, cara,
                 cumple: estado === "cumple", avisos };
      })
      .sort((a, b) => {
        if (a.sinCurva !== b.sinCurva) return a.sinCurva ? 1 : -1;
        return a.unidades - b.unidades
          || (a.hpTotal ?? 1e9) - (b.hpTotal ?? 1e9)
          || a.superavit - b.superavit;
      });

    return { area, hHombro, hCumbrera, hMedia, volumen, volumenFt3, areaLargoFt2, areaAnchoFt2,
      ppmLargo, ppmCara, qReq, pEst, k, candidatos };
  }, [dim, ach, presion, catalogo]);

  /* Un equipo sirve para extracción si su servicio lo dice, o si es mixto.
     Los que no declaran servicio entran en ambas listas: mejor ofrecerlos
     que esconderlos por un dato que falta en el catálogo. */
  const sirvePara = (c, servicio) => {
    const s = String(c.servicio || "");
    if (!s) return true;
    return servicio === "extraccion"
      ? /Extractor/i.test(s)
      : /Inyector/i.test(s);
  };

  const elegibles = calc.candidatos.filter((c) => !c.esRecirculador);
  const listaExt = elegibles.filter((c) => sirvePara(c, "extraccion"));
  const listaIny = elegibles.filter((c) => sirvePara(c, "inyeccion"));
  const listaServicio = servicio === "extraccion" ? listaExt : listaIny;
  /* Las líneas se sacan de lo que hay en el servicio activo: si un filtro
     no tiene equipos que ofrecer, mejor que ni aparezca. */
  const lineas = Array.from(new Set(listaServicio.map((c) => c.linea).filter(Boolean))).sort();
  const lista =
    lineaFiltro === "todas" || !lineas.includes(lineaFiltro)
      ? listaServicio
      : listaServicio.filter((c) => c.linea === lineaFiltro);

  const selExt = listaExt.find((c) => c.idx === elegido) || listaExt[0] || null;
  const selIny = listaIny.find((c) => c.idx === elegidoIny) || null;
  const seleccion = servicio === "extraccion" ? selExt : selIny || selExt;

  /* Unidades por servicio. El valor propuesto es el que cubre el caudal de
     diseño; se puede cambiar a mano para dejar la nave en presión positiva
     o negativa a propósito. */
  const udsExt = selExt ? Math.max(1, Math.round(manualExt ?? selExt.unidades)) : 0;
  const udsIny = selIny ? Math.max(1, Math.round(manualIny ?? selIny.unidades)) : 0;
  const flujoExt = selExt ? udsExt * selExt.qRef : 0;
  const flujoIny = selIny ? udsIny * selIny.qRef : 0;
  const balance = flujoExt > 0 && selIny ? (flujoIny / flujoExt - 1) * 100 : null;

  /* Cuánto se pasa o se queda corta la extracción frente al caudal que
     pide la nave. Es otra cosa que el balance: aquí se compara contra el
     diseño, no contra la inyección. */
  const difExt = selExt ? flujoExt - calc.qReq : null;
  const pctExt = selExt && calc.qReq > 0 ? (flujoExt / calc.qReq - 1) * 100 : null;

  /* Cuántas unidades hacen falta para llegar al caudal de diseño.
     Vale para extractores de pared, cada uno con su propia abertura:
     al ser independientes, los caudales se suman. Si compartieran un
     mismo ducto no sería así, porque cada equipo añadido sube la
     resistencia que ven los demás. */
  const requeridos = servicio === "extraccion" ? udsExt : udsIny;
  const instalado = servicio === "extraccion" ? flujoExt : flujoIny;

  const interpretar = async () => {
    if (!descripcion.trim()) return;
    setInterpretando(true);
    setErrIA("");
    try {
      const salida = await llamarClaude(
        `Extraes parámetros de ventilación de descripciones de naves y locales en español. Respondes ÚNICAMENTE con un objeto JSON, sin markdown ni texto adicional. Claves: largo, ancho, hombro, cumbrera (metros, número; hombro es la altura de columna o alero y cumbrera la altura máxima al caballete), tipo (uno de: ${Object.keys(TIPOS).join(", ")}). Si la descripción usa pies, conviértelos a metros. Omite las claves que no puedas determinar. No inventes dimensiones que no estén indicadas.`,
        descripcion
      );
      const p = JSON.parse(salida.replace(/```json|```/g, "").trim());
      if (p.tipo && TIPOS[p.tipo]) cambiarTipo(p.tipo);
      setDim((d) => ({
        largo: Number.isFinite(p.largo) ? p.largo : d.largo,
        ancho: Number.isFinite(p.ancho) ? p.ancho : d.ancho,
        hombro: Number.isFinite(p.hombro) ? p.hombro : d.hombro,
        cumbrera: Number.isFinite(p.cumbrera) ? p.cumbrera : d.cumbrera,
      }));
    } catch (e) {
      setErrIA("No se pudo interpretar la descripción. Indica dimensiones, alturas y uso, o carga los datos a mano.");
    } finally {
      setInterpretando(false);
    }
  };

  const redactar = async () => {
    if (!seleccion) return;
    setRedactando(true);
    setErrIA("");
    try {
      const datos = {
        recinto: TIPOS[tipo].nombre,
        renovaciones_recomendadas: `${TIPOS[tipo].min} a ${TIPOS[tipo].max} por hora`,
        planta_m: `${dim.largo} × ${dim.ancho}`,
        altura_hombro_m: calc.hHombro,
        altura_cumbrera_m: calc.hCumbrera,
        altura_media_m: +calc.hMedia.toFixed(2),
        area_m2: +calc.area.toFixed(0),
        volumen_m3: +calc.volumen.toFixed(0),
        volumen_ft3: +calc.volumenFt3.toFixed(0),
        renovaciones_hora: ach,
        criterio: "renovaciones de aire por hora sobre el volumen de la nave",
        caudal_diseno_cfm: +calc.qReq.toFixed(0),
        presion_estatica_inwg: +calc.pEst.toFixed(3),
        area_seccion_a_lo_largo_ft2: +calc.areaLargoFt2.toFixed(0),
        area_seccion_a_lo_ancho_ft2: +calc.areaAnchoFt2.toFixed(0),
        ppm_a_lo_largo: +calc.ppmLargo.toFixed(1),
        ppm_de_cara: +calc.ppmCara.toFixed(1),
        equipo: [[seleccion.marca, seleccion.modelo].filter(Boolean).join(" "),
          "(" + [seleccion.tipo, seleccion.diametro ? `Ø${seleccion.diametro} in` : null,
            seleccion.rpm ? `${seleccion.rpm} rpm` : null,
            seleccion.linea ? `línea ${seleccion.linea}` : null].filter(Boolean).join(", ") + ")"].join(" "),
        familia: FAMILIAS[seleccion.categoria] || "no indicada",
        punto_operacion: seleccion.sinCurva
          ? `no determinable: el equipo solo tiene el caudal a descarga libre, ${seleccion.qLibre.toFixed(0)} CFM`
          : `${seleccion.op.q.toFixed(0)} CFM a ${seleccion.op.p.toFixed(3)} in. w.g.`,
        potencia_nominal_hp: +seleccion.potencia.toFixed(2),
        holgura_pct: +seleccion.holgura.toFixed(1),
        servicio_del_equipo: servicio === "extraccion" ? "extracción" : "inyección",
        extraccion: selExt
          ? `${udsExt} × ${selExt.modelo} = ${flujoExt.toFixed(0)} CFM`
          : "sin definir",
        inyeccion: selIny
          ? `${udsIny} × ${selIny.modelo} = ${flujoIny.toFixed(0)} CFM`
          : "sin definir",
        extraccion_sobre_diseno_cfm: difExt == null ? null : +difExt.toFixed(0),
        extraccion_sobre_diseno_pct: pctExt == null ? null : +pctExt.toFixed(1),
        balance_pct: balance == null ? null : +balance.toFixed(1),
        unidades_exactas: +seleccion.exactas.toFixed(3),
        unidades_requeridas: requeridos,
        caudal_instalado_cfm: +instalado.toFixed(0),
        sobrante_cfm: +seleccion.superavitCfm.toFixed(0),
        sobrante_pct: +seleccion.superavit.toFixed(1),
        potencia_total_hp: seleccion.hpTotal != null ? +seleccion.hpTotal.toFixed(2) : null,
        avisos: seleccion.avisos,
      };
      const texto = await llamarClaude(
        "Eres ingeniero de ventilación y redactas la memoria de cálculo del proyecto en español técnico. La geometría de la nave va en metros y el aire y el equipo en unidades de catálogo: CFM, in. w.g., pulgadas, FPM y HP. Usa cada magnitud en la unidad en que te llega y no conviertas entre sistemas. Trabajas exclusivamente con las cifras que recibes: no recalcules, no estimes valores que no estén en los datos y no cites normas por número de artículo. Estructura: geometría y volumen de la nave, caudal de diseño y renovaciones aplicadas, presión estática de diseño, secciones transversales y velocidades resultantes, punto de operación del equipo, cuántas unidades hacen falta y el caudal instalado que resulta, el balance entre inyección y extracción con la presión que deja en la nave, y observaciones. Tres a cinco párrafos, sin viñetas, sin encabezados, sin preámbulo.",
        "Datos del cálculo:\n" + JSON.stringify(datos, null, 2)
      );
      setMemoria(texto);
    } catch (e) {
      setErrIA("No se pudo redactar la memoria. Intenta de nuevo.");
    } finally {
      setRedactando(false);
    }
  };

  const importar = () => {
    try {
      const datos = JSON.parse(jsonTexto);
      if (!Array.isArray(datos) || !datos.length) throw new Error();
      datos.forEach((e) => {
        if (!e.modelo || !Array.isArray(e.curva) || e.curva.length < 1) throw new Error();
      });
      setCatalogo(datos);
      setOrigen("json");
      setElegido(null);
      setErrImport("");
      setImportOpen(false);
      setJsonTexto("");
    } catch {
      setErrImport("El JSON no tiene la estructura esperada. Cada equipo necesita modelo y al menos un punto [CFM, in. w.g., HP].");
    }
  };

  const plantilla = JSON.stringify(
    [{ marca: "Marca", modelo: "Modelo", tipo: "Axial", diametro: 36, rpm: 870,
       foto: "https://…/ax-36.jpg", fichaUrl: "https://…/ax-36.pdf",
       curva: [[0, 1.55, 1.9], [6000, 1.25, 2.9], [12000, 0.58, 3.7], [15500, 0, 3.9]] }],
    null, 2
  );

  if (!sesion) {
    return (
      <>
        <style>{ESTILOS}</style>
        <PantallaAcceso onEntrar={setSesion} />
      </>
    );
  }

  return (
    <div className="vs-root">
      <style>{`
        .vs-root{--ink:#2b2f6e;--graf:#666666;--mudo:#8a8a93;--paper:#f2f2f5;--card:#fff;
          --rule:#dcdce2;--air:#ff8300;--air-txt:#a85700;--airsoft:#fff2e3;--tinta-suave:#e9eaf2;--sig:#c62828;--sigsoft:#fbeaea;
          --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
          font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
          background:var(--paper);color:var(--ink);padding:24px;line-height:1.5;
          -webkit-font-smoothing:antialiased}
        .vs-root *{box-sizing:border-box}
        .vs-head{max-width:1180px;margin:0 auto 22px;border-bottom:2px solid var(--ink);padding-bottom:14px}
        .vs-eyebrow{font-family:var(--mono);font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--air-txt);margin:0 0 6px}
        .vs-head h1{margin:0;font-size:27px;font-weight:650;letter-spacing:-.02em}
        .vs-head p{margin:6px 0 0;color:var(--graf);font-size:14px;max-width:64ch}
        .vs-wrap{max-width:1180px;margin:0 auto;display:grid;grid-template-columns:minmax(0,380px) minmax(0,1fr);gap:20px;align-items:start}
        @media(max-width:900px){.vs-root{padding:16px}.vs-wrap{grid-template-columns:1fr}}

        .vs-panel{background:var(--card);border:1px solid var(--rule);border-radius:4px;margin-bottom:16px}
        .vs-panel>header{display:flex;align-items:baseline;gap:9px;padding:11px 14px;border-bottom:1px solid var(--rule)}
        .vs-idx{font-family:var(--mono);font-size:10px;color:var(--mudo);letter-spacing:.1em}
        .vs-panel h2{margin:0;font-size:12px;font-weight:650;letter-spacing:.07em;text-transform:uppercase}
        .vs-panel-body{padding:14px}
        .vs-nota{margin:0;padding:9px 14px;border-top:1px dashed var(--rule);font-size:11.5px;color:var(--mudo)}

        .vs-grid2{display:grid;grid-template-columns:1fr 1fr;gap:11px}
        .vs-campo{display:flex;flex-direction:column;gap:4px;min-width:0}
        .vs-lab{font-family:var(--mono);font-size:9.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--mudo);display:flex;justify-content:space-between;gap:6px}
        .vs-lab em{font-style:normal;color:var(--air-txt)}
        .vs-root input[type=number],.vs-root input[type=text],.vs-root select,.vs-root textarea{width:100%;font-family:var(--mono);font-size:14px;
          padding:7px 9px;border:1px solid var(--rule);border-radius:3px;background:#fcfcfd;color:var(--ink)}
        .vs-root input[readonly]{background:#f4f4f8;color:var(--graf)}
        .vs-root textarea{font-family:inherit;font-size:13.5px;resize:vertical}
        .vs-root select{font-family:inherit;font-size:13.5px}
        .vs-root input:focus-visible,.vs-root select:focus-visible,.vs-root textarea:focus-visible,.vs-root button:focus-visible{
          outline:2px solid var(--air);outline-offset:1px}

        .vs-nave{width:100%;height:auto;display:block;margin:2px 0 12px}
        .vs-iso-pared{fill:#fdfdfe;stroke:var(--ink);stroke-width:1.4;stroke-linejoin:round}
        .vs-iso-gable{fill:#f4f4f9;stroke:var(--ink);stroke-width:1.4;stroke-linejoin:round}
        .vs-iso-techo-a{fill:#ffe3c4;stroke:var(--ink);stroke-width:1.4;stroke-linejoin:round}
        .vs-iso-techo-b{fill:#ffcd9f;stroke:var(--ink);stroke-width:1.4;stroke-linejoin:round}
        .vs-planta-halo{fill:none;stroke:var(--ink);stroke-width:1.2}
        .vs-zona-max{fill:#ffe3c4;opacity:.75}
        .vs-zona-min{fill:#ffc78e;opacity:.85}
        .vs-fachada{fill:none;stroke:var(--ink);stroke-width:1.6;stroke-linejoin:round}
        .vs-suelo-l{stroke:var(--ink);stroke-width:1.6}
        .vs-equipo{fill:var(--ink);stroke:var(--ink);stroke-width:1}
        .vs-cl-max{stroke:var(--air);stroke-width:1.4}
        .vs-cl-min{stroke:var(--ink);stroke-width:1.4}
        .vs-iso-oculto{fill:none;stroke:var(--mudo);stroke-width:.8;stroke-dasharray:3 3}
        .vs-iso-eje{stroke:var(--mudo);stroke-width:1;stroke-dasharray:3 3}
        .vs-cota line{stroke:var(--mudo);stroke-width:.8}
        .vs-cota text{font-family:var(--mono);font-size:10px;fill:var(--graf)}
        .vs-cota-halo{paint-order:stroke;stroke:var(--card);stroke-width:3.5px;stroke-linejoin:round}


        .vs-btn{font:inherit;font-size:13px;font-weight:550;padding:8px 14px;border-radius:3px;cursor:pointer;
          border:1px solid var(--ink);background:var(--ink);color:#fff}
        .vs-btn:disabled{opacity:.45;cursor:default}
        .vs-btn.ghost{background:transparent;color:var(--ink)}

        .vs-readout{background:var(--ink);color:#fff;border-radius:4px;padding:18px;margin-bottom:16px}
        .vs-readout .vs-eyebrow{color:#ffab5c}
        .vs-cifra{display:flex;align-items:baseline;gap:9px;font-family:var(--mono);margin:2px 0 14px;flex-wrap:wrap}
        .vs-cifra b{font-size:44px;font-weight:600;letter-spacing:-.03em;line-height:1}
        .vs-cifra span{font-size:13px;color:#a9ace0}
        .vs-balance{margin:12px 0 0;font-size:12.5px;color:#a9ace0;line-height:1.5}
        .vs-balance b{color:#fff;font-family:var(--mono)}
        .vs-req-eq{margin:-6px 0 10px;font-family:var(--mono);font-size:12px;color:#a9ace0;line-height:1.5}
        .vs-req-eq b{color:#fff;font-size:15px}
        .vs-req-eq em{font-style:normal;color:#ffab5c}
        .vs-mini{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:#414590;border:1px solid #414590;border-radius:3px}
        @media(max-width:560px){.vs-mini{grid-template-columns:1fr 1fr}}
        .vs-mini div{background:var(--ink);padding:9px 10px}
        .vs-mini dt{font-family:var(--mono);font-size:9px;letter-spacing:.09em;text-transform:uppercase;color:#a9ace0;margin:0 0 3px}
        .vs-mini dd{margin:0;font-family:var(--mono);font-size:15px}

        .vs-svg{width:100%;height:auto;display:block}
        .vs-grid{stroke:var(--rule);stroke-width:1}
        .vs-tick{font-family:var(--mono);font-size:9px;fill:var(--mudo)}
        .vs-axis{font-family:var(--mono);font-size:9px;letter-spacing:.1em;fill:var(--mudo)}
        .vs-ventilador{fill:none;stroke:var(--ink);stroke-width:2.2;stroke-linejoin:round}
        .vs-sistema{fill:none;stroke:var(--air);stroke-width:1.8;stroke-dasharray:6 4}
        .vs-req{stroke:var(--mudo);stroke-width:1;stroke-dasharray:2 3}
        .vs-etq{font-family:var(--mono);font-size:9px;fill:var(--mudo)}
        .vs-cruz{stroke:var(--mudo);stroke-width:.8;stroke-dasharray:2 2}
        .vs-op-halo{fill:var(--airsoft);stroke:var(--air);stroke-width:1}
        .vs-op{fill:var(--air)}
        .vs-op-etq{font-family:var(--mono);font-size:11px;font-weight:600;fill:var(--ink)}
        .vs-leyenda text{font-family:var(--mono);font-size:9.5px;fill:var(--graf)}

        .vs-sincurva{padding:4px 2px 2px}
        .vs-sincurva p{margin:0 0 10px;font-size:13px;color:var(--graf);line-height:1.55;max-width:62ch}
        .vs-sincurva p:last-child{margin-bottom:2px}
        .vs-sincurva-cifra{font-family:var(--mono);font-size:34px;font-weight:600;color:var(--ink);
          letter-spacing:-.02em;margin:2px 0 12px!important}
        .vs-sincurva-cifra span{font-size:13px;color:var(--mudo);font-weight:400}
        .vs-tag{display:inline-block;margin-top:4px;font-family:var(--mono);font-size:9px;
          letter-spacing:.07em;text-transform:uppercase;color:var(--air-txt);
          background:var(--airsoft);padding:2px 6px;border-radius:2px}
        .vs-tabla{width:100%;border-collapse:collapse;font-size:13px}
        .vs-tabla th{font-family:var(--mono);font-size:9px;letter-spacing:.09em;text-transform:uppercase;color:var(--mudo);
          text-align:right;padding:0 10px 7px;font-weight:400;border-bottom:1px solid var(--rule)}
        .vs-tabla th:first-child{text-align:left}
        .vs-tabla td{padding:9px 10px;border-bottom:1px solid #eeeef3;text-align:right;font-family:var(--mono)}
        .vs-tabla td:first-child{text-align:left;font-family:inherit}
        .vs-tabla tr{cursor:pointer}
        .vs-tabla tr.on td{background:var(--tinta-suave)}
        .vs-tabla tr.no td{color:var(--mudo)}
        .vs-modelo{font-weight:600}
        .vs-sub{display:block;font-size:11px;color:var(--mudo);font-weight:400}
        .vs-scroll{overflow-x:auto}

        .vs-aviso{display:flex;gap:8px;background:var(--sigsoft);border-left:2px solid var(--sig);
          padding:8px 11px;border-radius:2px;font-size:12.5px;color:#8c1d1d;margin-top:8px}
        .vs-err{background:var(--sigsoft);border-left:2px solid var(--sig);padding:8px 11px;
          border-radius:2px;font-size:12.5px;color:#8c1d1d;margin:10px 0 0}
        .vs-memoria{white-space:pre-wrap;font-size:13.5px;line-height:1.62;color:var(--graf)}
        .vs-vacio{font-size:13px;color:var(--mudo);margin:0}
        .vs-fila{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
        .vs-cat-elegidos{display:flex;flex-direction:column;gap:8px;margin-bottom:14px;
          padding-bottom:14px;border-bottom:1px dashed var(--rule)}
        .vs-cat-fila{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
        .vs-cat-fila .vs-lab{min-width:74px}
        .vs-cat-fila .vs-btn{font-size:12px;padding:6px 11px}
        .vs-cat{font-family:var(--mono);font-size:11px;color:var(--mudo);margin:0;
          display:flex;align-items:center;gap:6px;flex-wrap:wrap}
        .vs-punto{width:7px;height:7px;border-radius:50%;flex:none;background:var(--mudo)}
        .vs-punto.vivo{background:var(--air)}
        .vs-punto.cargando{background:var(--air);animation:vs-late 1s ease-in-out infinite}
        .vs-punto.inerte{background:var(--rule);border:1px solid var(--mudo)}
        @keyframes vs-late{50%{opacity:.25}}

        .vs-tabs{display:inline-flex;border:1px solid var(--rule);border-radius:3px;overflow:hidden;margin-top:14px}
        .vs-tab{font:inherit;font-size:11.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;
          padding:8px 16px;background:var(--card);color:var(--mudo);border:none;border-right:1px solid var(--rule);cursor:pointer}
        .vs-tab:last-child{border-right:none}
        .vs-tab.on{background:var(--ink);color:#fff}

        .vs-equipos{max-width:1180px;margin:0 auto}
        .vs-filtros{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:18px}
        .vs-chip{font:inherit;font-size:12px;padding:6px 12px;border:1px solid var(--rule);border-radius:20px;
          background:var(--card);color:var(--graf);cursor:pointer}
        .vs-chip.on{background:var(--airsoft);border-color:var(--air);color:var(--air-txt);font-weight:600}
        .vs-filtros-fam{margin-bottom:10px;padding-bottom:14px;border-bottom:1px solid var(--rule)}
        .vs-card-fam{margin:3px 0 0;font-family:var(--mono);font-size:9.5px;letter-spacing:.07em;
          text-transform:uppercase;color:var(--air-txt)}
        .vs-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(252px,1fr));gap:16px}
        .vs-card{background:var(--card);border:1px solid var(--rule);border-radius:4px;display:flex;flex-direction:column;overflow:hidden}
        .vs-card.on{border-color:var(--air);box-shadow:inset 0 0 0 1px var(--air)}
        .vs-card-img{background:#f7f7fb;border-bottom:1px solid var(--rule);padding:14px;
          display:flex;align-items:center;justify-content:center;min-height:132px}
        .vs-card-img img{max-width:100%;max-height:128px;object-fit:contain}
        .vs-ilu{width:100%;max-width:168px;height:auto}
        .vs-ilu-cuerpo{fill:#fff;stroke:var(--ink);stroke-width:1.6;stroke-linejoin:round}
        .vs-ilu-aspa{fill:var(--airsoft);stroke:var(--ink);stroke-width:1.2;stroke-linejoin:round}
        .vs-ilu-det{fill:none;stroke:var(--air);stroke-width:1.3;stroke-linecap:round;stroke-linejoin:round}
        .vs-card-body{padding:13px 14px 14px;display:flex;flex-direction:column;gap:10px;flex:1}
        .vs-card-top{display:flex;justify-content:space-between;align-items:flex-start;gap:8px}
        .vs-card-body h3{margin:0;font-size:15px;font-weight:650;letter-spacing:-.01em}
        .vs-card-sub{margin:2px 0 0;font-size:11.5px;color:var(--mudo)}
        .vs-specs{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;margin:0;background:var(--rule);
          border:1px solid var(--rule);border-radius:3px}
        .vs-specs div{background:var(--card);padding:6px 7px;min-width:0}
        .vs-specs dt{font-family:var(--mono);font-size:8.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--mudo);margin:0 0 2px}
        .vs-specs dd{margin:0;font-family:var(--mono);font-size:12.5px}
        .vs-mini-curva{width:100%;height:40px;display:block}
        .vs-mini-curva path{fill:none;stroke:var(--ink);stroke-width:1.6;stroke-linejoin:round}
        .vs-card-op{margin:0;font-size:11.5px;color:var(--mudo);line-height:1.45}
        .vs-card-op b{color:var(--ink);font-family:var(--mono)}
        .vs-card-acc{display:flex;gap:6px;flex-wrap:wrap;margin-top:auto}
        .vs-card-acc .vs-btn{font-size:12px;padding:7px 11px}
        .vs-sin-pdf{font-family:var(--mono);font-size:10.5px;color:var(--mudo);
          align-self:center;padding:0 4px}
        a.vs-btn{text-decoration:none;display:inline-block}
      `}</style>

      <div className="vs-head">
        <h1>Selector de ventilación general</h1>
        <div className="vs-tabs" role="tablist">
          {[["selector", "Selector"], ["recirculacion", "Recirculación"], ["equipos", "Equipos"]].map(([v, t]) => (
            <button key={v} role="tab" aria-selected={vista === v}
              className={"vs-tab" + (vista === v ? " on" : "")}
              onClick={() => setVista(v)}>{t}</button>
          ))}
          <button className="vs-tab" onClick={salir} title="Cerrar sesión">Salir</button>
        </div>
      </div>

      {vista === "recirculacion" ? (
        <PaginaRecirculacion
          catalogo={catalogo}
          ancho={num(dim.ancho)}
          largo={num(dim.largo)}
          hombro={num(dim.hombro)}
          cumbrera={Math.max(num(dim.cumbrera), num(dim.hombro))}
          onAncho={(v) => setDim({ ...dim, ancho: v })}
          onLargo={(v) => setDim({ ...dim, largo: v })}
          elegido={recirEq}
          onElegir={(m) => { setRecirEq(m); setRecirUds(null); }}
          unidades={recirUds}
          onUnidades={(v) => { setRecirUds(v); setRecirFilas(null); }}
          filasSel={recirFilas}
          onFilas={setRecirFilas}
        />
      ) : vista === "equipos" ? (
        <PaginaEquipos
          catalogo={catalogo}
          candidatos={calc.candidatos}
          qReq={calc.qReq}
          elegido={seleccion?.idx ?? null}
          esDemo={origen === "demo"}
          onDemo={() => { setCatalogo(CATALOGO_DEMO); setOrigen("demo"); setElegido(null); }}
          onElegir={(i) => {
            if (servicio === "extraccion") { setElegido(i); setManualExt(null); }
            else { setElegidoIny(i); setManualIny(null); }
            setMemoria("");
            setVista("selector");
          }}
        />
      ) : (

      <div className="vs-wrap">
        {/* ---------- entrada ---------- */}
        <div>
          <Panel indice="00" titulo="Describir la nave"
            nota="La IA rellena los campos de abajo. Revísalos siempre antes de calcular.">
            <textarea rows={3} value={descripcion}
              placeholder="Nave de producción de 30 por 18 metros, 6 al hombro y 8.5 a la cumbrera."
              onChange={(e) => setDescripcion(e.target.value)} />
            <div className="vs-fila" style={{ marginTop: 10 }}>
              <button className="vs-btn" onClick={interpretar} disabled={!IA_ACTIVA || interpretando || !descripcion.trim()}>
                {interpretando ? "Interpretando…" : "Interpretar con Claude"}
              </button>
            </div>
            {errIA && <p className="vs-err">{errIA}</p>}
          </Panel>

          <Panel indice="01" titulo="Geometría de la nave"
            nota="El volumen usa la altura media entre hombro y cumbrera, válida para cubierta simétrica a dos aguas. Para techo plano, iguala ambas cotas de altura. El volumen se convierte a ft³ para dar el caudal en CFM.">
            <NaveIso largo={num(dim.largo)} ancho={num(dim.ancho)} hombro={num(dim.hombro)}
              cumbrera={Math.max(num(dim.cumbrera), num(dim.hombro))} />
            <div className="vs-grid2">
              <Campo etiqueta="Largo" unidad="m" paso={0.5} valor={dim.largo}
                onChange={(v) => setDim({ ...dim, largo: v })} />
              <Campo etiqueta="Ancho" unidad="m" paso={0.5} valor={dim.ancho}
                onChange={(v) => setDim({ ...dim, ancho: v })} />
              <Campo etiqueta="Altura al hombro" unidad="m" paso={0.1} valor={dim.hombro}
                onChange={(v) => setDim({ ...dim, hombro: v })} />
              <Campo etiqueta="Altura a cumbrera" unidad="m" paso={0.1} valor={dim.cumbrera}
                onChange={(v) => setDim({ ...dim, cumbrera: v })} />
            </div>
            {num(dim.cumbrera) < num(dim.hombro) && (
              <div className="vs-aviso"><span>▲</span>
                <span>La cumbrera está por debajo del hombro. Se calcula con techo plano a la altura del hombro.</span>
              </div>
            )}
            <div className="vs-grid2" style={{ marginTop: 11 }}>
              <label className="vs-campo">
                <span className="vs-lab">Altura media<em>m</em></span>
                <input type="text" readOnly value={fmt(calc.hMedia, 2)} />
              </label>
              <label className="vs-campo">
                <span className="vs-lab">Superficie<em>m²</em></span>
                <input type="text" readOnly value={fmt(calc.area)} />
              </label>
            </div>
          </Panel>

          <Panel indice="02" titulo="Tipo de área">
            <label className="vs-campo" style={{ marginBottom: 11 }}>
              <span className="vs-lab">Uso</span>
              <select value={tipo} onChange={(e) => cambiarTipo(e.target.value)}>
                {Object.entries(TIPOS).map(([k, v]) => (
                  <option key={k} value={k}>{v.nombre} — {v.min} a {v.max} RPH</option>
                ))}
              </select>
            </label>
            <div className="vs-grid2">
              <label className="vs-campo">
                <span className="vs-lab">Volumen<em>m³</em></span>
                <input type="text" readOnly value={fmt(calc.volumen)} />
              </label>
              <label className="vs-campo">
                <span className="vs-lab">Volumen<em>ft³</em></span>
                <input type="text" readOnly value={fmt(calc.volumenFt3)} />
              </label>
            </div>
          </Panel>

          <Panel indice="03" titulo="Renovaciones de aire"
            nota="Renovaciones usadas son las mínimas recomendadas">
            <div className="vs-grid2">
              <Campo etiqueta="Renovaciones" unidad="/h" paso={0.5} valor={ach} onChange={setAch} />
              <label className="vs-campo">
                <span className="vs-lab">Recomendado<em>RPH</em></span>
                <input type="text" readOnly value={`${TIPOS[tipo].min} a ${TIPOS[tipo].max}`} />
              </label>
            </div>
          </Panel>

          <Panel indice="04" titulo="Presión estática">
            <div className="vs-grid2">
              <Campo etiqueta="Presión de diseño" unidad="in. w.g." paso={0.01} valor={presion}
                onChange={setPresion} />
            </div>
          </Panel>

          <Panel indice="05" titulo="Catálogo"
            nota="El catálogo se descarga de Supabase al iniciar sesión. Usa Recargar si acabas de cambiar algo en la base.">
            {(selExt || selIny) && (
              <div className="vs-cat-elegidos">
                {[["Extracción", selExt], ["Inyección", selIny]].map(([rot, eq]) => (
                  <div key={rot} className="vs-cat-fila">
                    <span className="vs-lab">{rot}</span>
                    {!eq ? (
                      <span className="vs-sin-pdf">sin equipo elegido</span>
                    ) : eq.fichaUrl ? (
                      <a className="vs-btn ghost" href={eq.fichaUrl}
                        target="_blank" rel="noreferrer">
                        Catálogo {eq.linea || eq.modelo}
                      </a>
                    ) : (
                      <span className="vs-sin-pdf">
                        {eq.linea || eq.modelo} · sin catálogo cargado
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}

            <p className="vs-cat">
              <span className={"vs-punto " + (cargandoCat ? "cargando"
                : origen === "supabase" ? "vivo" : "inerte")} />
              {cargandoCat
                ? "Consultando Supabase…"
                : `${catalogo.length} equipos · ${
                    origen === "supabase" ? "conectado a Supabase"
                    : origen === "json" ? "importados por JSON"
                    : "catálogo integrado"}`}
            </p>

            <div className="vs-grid2" style={{ marginTop: 11 }}>
              <label className="vs-campo" style={{ gridColumn: "1 / -1" }}>
                <span className="vs-lab">URL del proyecto</span>
                <input type="text" value={conf.url} placeholder="https://xxxx.supabase.co"
                  onChange={(e) => setConf({ ...conf, url: e.target.value })} />
              </label>
              <label className="vs-campo" style={{ gridColumn: "1 / -1" }}>
                <span className="vs-lab">Clave anon<em>pública</em></span>
                <input type="text" value={conf.clave} placeholder="eyJhbGciOi…"
                  onChange={(e) => setConf({ ...conf, clave: e.target.value })} />
              </label>
            </div>

            <div className="vs-fila" style={{ marginTop: 10 }}>
              <button className="vs-btn" onClick={() => conectarSupabase(conf.url, conf.clave, sesion?.access_token)}
                disabled={cargandoCat || !conf.url || !conf.clave}>
                {cargandoCat ? "Cargando…" : origen === "supabase" ? "Recargar" : "Conectar"}
              </button>
              <button className="vs-btn ghost" onClick={() => setVista("equipos")}>
                Ver y escoger equipos
              </button>
            </div>
            {errCat && <p className="vs-err">{errCat}</p>}
            {importOpen && (
              <div style={{ marginTop: 12 }}>
                <span className="vs-lab" style={{ marginBottom: 4 }}>
                  JSON · curva como [CFM, in. w.g., HP] · foto y fichaUrl son opcionales
                </span>
                <textarea rows={7} value={jsonTexto} placeholder={plantilla}
                  onChange={(e) => setJsonTexto(e.target.value)}
                  style={{ fontFamily: "var(--mono)", fontSize: 11.5 }} />
                <div className="vs-fila" style={{ marginTop: 9 }}>
                  <button className="vs-btn" onClick={importar} disabled={!jsonTexto.trim()}>Cargar</button>
                  <button className="vs-btn ghost" onClick={() => setJsonTexto(plantilla)}>Ver plantilla</button>
                </div>
                {errImport && <p className="vs-err">{errImport}</p>}
              </div>
            )}
          </Panel>
        </div>

        {/* ---------- resultados ---------- */}
        <div>
          <div className="vs-readout">
            <p className="vs-eyebrow">Caudal de diseño</p>
            <div className="vs-cifra">
              <b>{fmt(calc.qReq)}</b>
              <span>CFM</span>
            </div>
            {selExt && (
              <p className="vs-req-eq">
                <b>Extracción</b> · {udsExt} {udsExt === 1 ? "equipo" : "equipos"}{" "}
                {selExt.modelo} · {fmt(selExt.qRef)} CFM cada uno ·{" "}
                <b>{fmt(flujoExt)} CFM</b>
                {pctExt != null && (
                  <> · {difExt >= 0 ? "+" : ""}{fmt(difExt)} CFM{" "}
                  ({pctExt >= 0 ? "+" : ""}{pctExt.toFixed(1)} %) sobre el diseño</>
                )}
                {selExt.hp ? ` · ${(udsExt * selExt.hp).toFixed(2)} HP` : ""}
              </p>
            )}
            {selIny ? (
              <p className="vs-req-eq">
                <b>Inyección</b> · {udsIny} {udsIny === 1 ? "equipo" : "equipos"}{" "}
                {selIny.modelo} · {fmt(selIny.qRef)} CFM cada uno ·{" "}
                <b>{fmt(flujoIny)} CFM</b>
                {selIny.hp ? ` · ${(udsIny * selIny.hp).toFixed(2)} HP` : ""}
              </p>
            ) : (
              <p className="vs-req-eq">
                <em>Sin equipo de inyección definido. Elígelo en la sección
                Equipos elegibles, en la etiqueta Inyección.</em>
              </p>
            )}
            <dl className="vs-mini">
              <div>
                <dt>Volumen</dt>
                <dd>{fmt(calc.volumen)} m³</dd>
              </div>
              <div>
                <dt>Volumen</dt>
                <dd>{fmt(calc.volumenFt3)} ft³</dd>
              </div>
              <div>
                <dt>Renovaciones</dt>
                <dd>{fmt(num(ach), 1)} /h</dd>
              </div>
              <div>
                <dt>Área a lo largo</dt>
                <dd>{fmt(calc.areaLargoFt2)} ft²</dd>
              </div>
              <div>
                <dt>Área a lo ancho</dt>
                <dd>{fmt(calc.areaAnchoFt2)} ft²</dd>
              </div>
              <div>
                <dt>ppm a lo largo</dt>
                <dd>{fmt(calc.ppmLargo, 1)}</dd>
              </div>
              <div>
                <dt>ppm de cara</dt>
                <dd>{fmt(calc.ppmCara, 1)}</dd>
              </div>
              <div>
                <dt>Equipos</dt>
                <dd>{selExt ? `${selExt.exactas.toFixed(2)} → ${udsExt} ud` : "—"}</dd>
              </div>
              <div>
                <dt>Balance</dt>
                <dd style={balance == null ? undefined
                  : { color: Math.abs(balance) <= 10 ? "#7fd3d8" : "#ffab5c" }}>
                  {balance == null ? "—"
                    : `${balance >= 0 ? "+" : ""}${balance.toFixed(1)} %`}
                </dd>
              </div>
            </dl>
            {balance != null && (
              <p className="vs-balance">
                {fmt(flujoIny)} CFM inyectados frente a {fmt(flujoExt)} extraídos:{" "}
                <b>{balance >= 0 ? "+" : ""}{balance.toFixed(1)} %</b>.{" "}
                {Math.abs(balance) <= 5
                  ? "Prácticamente equilibrada."
                  : balance > 0
                  ? "La nave queda en presión positiva: el aire sale por puertas y huecos."
                  : "La nave queda en presión negativa: entra aire sin filtrar por puertas y huecos."}
              </p>
            )}
          </div>

          <Panel indice="06"
            titulo={seleccion ? `Punto de operación · ${[seleccion.marca, seleccion.modelo].filter(Boolean).join(" ")}` : "Punto de operación"}>
            {!seleccion ? (
              <p className="vs-vacio">Carga un catálogo con al menos un equipo para trazar las curvas.</p>
            ) : seleccion.sinCurva ? (
              <div className="vs-sincurva">
                <p className="vs-eyebrow">Caudal a descarga libre</p>
                <p className="vs-sincurva-cifra">{fmt(seleccion.qLibre)} <span>CFM</span></p>
                <p>Este equipo no cuenta con curva, solo con caudal libre.</p>
              </div>
            ) : (
              <Curvas equipo={seleccion} k={calc.k} qReq={calc.qReq} op={seleccion.op} />
            )}
            {seleccion?.avisos.map((a) => (
              <div className="vs-aviso" key={a}><span>▲</span><span>{a}</span></div>
            ))}
          </Panel>

          <Panel indice="07" titulo={`Equipos elegibles · ${servicio === "extraccion" ? "extracción" : "inyección"}`}
            nota="Ordenados por menos unidades, luego menos potencia total y menos sobrante. La columna en CFM es la diferencia entre el caudal instalado y el de diseño.">
            <div className="vs-filtros" style={{ marginBottom: 12 }}>
              {[["extraccion", "Extracción"], ["inyeccion", "Inyección"]].map(([v, t]) => (
                <button key={v} className={"vs-chip" + (servicio === v ? " on" : "")}
                  onClick={() => setServicio(v)} aria-pressed={servicio === v}>
                  {t}
                </button>
              ))}
              <span style={{ flex: 1 }} />
              <label className="vs-campo" style={{ maxWidth: 150 }}>
                <span className="vs-lab">Línea</span>
                <select value={lineaFiltro} onChange={(e) => setLineaFiltro(e.target.value)}>
                  <option value="todas">Todas ({listaServicio.length})</option>
                  {lineas.map((l) => (
                    <option key={l} value={l}>
                      {l} ({listaServicio.filter((c) => c.linea === l).length})
                    </option>
                  ))}
                </select>
              </label>
              <label className="vs-campo" style={{ maxWidth: 110 }}>
                <span className="vs-lab">Unidades</span>
                <input type="number" min={1} step={1}
                  value={servicio === "extraccion" ? udsExt : udsIny}
                  onChange={(e) => {
                    const v = e.target.value === "" ? null : Number(e.target.value);
                    servicio === "extraccion" ? setManualExt(v) : setManualIny(v);
                  }} />
              </label>
            </div>
            <div className="vs-scroll">
              <table className="vs-tabla">
                <thead>
                  <tr>
                    <th>Equipo</th>
                    <th>CFM c/u</th>
                    <th>Uds</th>
                    <th>Instalado</th>
                    <th>en CFM</th>
                    <th>HP total</th>
                  </tr>
                </thead>
                <tbody>
                  {lista.map((c) => (
                    <tr key={c.idx}
                      onClick={() => {
                        if (servicio === "extraccion") { setElegido(c.idx); setManualExt(null); }
                        else { setElegidoIny(c.idx); setManualIny(null); }
                      }}
                      className={(c.idx === (servicio === "extraccion" ? selExt?.idx : selIny?.idx) ? "on " : "")
                        + (c.estado === "insuficiente" ? "no" : "")}>
                      <td>
                        <span className="vs-modelo">{c.modelo}</span>
                        <span className="vs-sub">
                          {[c.tipo, c.diametro ? `Ø${c.diametro}″` : null,
                            c.linea, c.rpm ? `${c.rpm} rpm` : null]
                            .filter(Boolean).join(" · ")}
                        </span>
                        {c.sinCurva && <span className="vs-tag">solo descarga libre</span>}
                      </td>
                      <td>{fmt(c.qRef)}</td>
                      <td>{c.unidades}</td>
                      <td>{fmt(c.instalado)}</td>
                      <td style={{ color: c.superavit > 40 ? "var(--air-txt)" : "var(--ink)" }}>
                        {c.superavitCfm >= 0 ? "+" : ""}{fmt(c.superavitCfm)}
                      </td>
                      <td>{c.hpTotal != null ? c.hpTotal.toFixed(2) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel indice="08" titulo="Memoria de cálculo"
            nota="Redactada por Claude a partir de las cifras calculadas. Revísala y fírmala tú.">
            <div className="vs-fila">
              <button className="vs-btn" onClick={redactar} disabled={!IA_ACTIVA || redactando || !seleccion}>
                {redactando ? "Redactando…" : memoria ? "Volver a redactar" : "Redactar memoria"}
              </button>
              {memoria && (
                <button className="vs-btn ghost" onClick={() => navigator.clipboard?.writeText(memoria)}>
                  Copiar
                </button>
              )}
            </div>
            {memoria ? (
              <p className="vs-memoria" style={{ marginTop: 14 }}>{memoria}</p>
            ) : (
              <p className="vs-vacio" style={{ marginTop: 12 }}>
                Sin memoria todavía. Ajusta los parámetros y redáctala cuando el punto de operación te convenza.
              </p>
            )}
          </Panel>
        </div>
      </div>
      )}
    </div>
  );
}
