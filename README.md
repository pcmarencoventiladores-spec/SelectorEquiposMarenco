# Selector de ventilación general

Dimensionado de ventilación general y recirculación para naves industriales.
Catálogo de 204 equipos incluido en la aplicación; opcionalmente se recarga
desde Supabase para traer cambios recientes, fotos y fichas.

## Publicar en GitHub Pages

1. Crea un repositorio y sube estos archivos.
2. En **Settings › Pages**, en *Source*, elige **GitHub Actions**.
3. En **Settings › Secrets and variables › Actions**:
   - pestaña **Variables**: `VITE_SUPABASE_URL` = `https://rsbjmunbljolbhhsdusk.supabase.co`
   - pestaña **Secrets**: `VITE_SUPABASE_ANON_KEY` = tu clave anon
4. Haz push a `main`. El flujo construye y publica solo.

La web queda en `https://USUARIO.github.io/REPOSITORIO/`.

El `base` de Vite se calcula con el nombre del repositorio dentro del flujo.
Si lo montas en un dominio propio o en `USUARIO.github.io`, quita esa línea
de `deploy.yml`: con un `base` equivocado la página carga en blanco.

## Sobre las claves

La `anon` de Supabase acaba dentro del JavaScript que sirve la web, y no pasa
nada: está diseñada para eso. No concede acceso por sí sola, lo que manda es
la política RLS, que aquí solo permite leer equipos activos. La guardo como
secreto del repositorio para no tenerla en el código, no porque sea secreta.

La `service_role` se salta RLS por completo. Nunca debe entrar aquí.

## Las funciones de IA

Interpretar la descripción de la nave y redactar la memoria necesitan la API
de Anthropic, y eso pide una clave que no puede vivir en el navegador. Sin
configurar nada, esos dos botones salen desactivados y el resto funciona
igual: los cálculos, los esquemas, el catálogo y las descargas no dependen
de la IA.

Para activarlos, despliega la función incluida en `supabase/functions/asistente`:

```bash
supabase functions deploy asistente --no-verify-jwt
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
supabase secrets set ORIGEN_PERMITIDO=https://USUARIO.github.io
```

Y añade la variable `VITE_IA_ENDPOINT` en el repositorio:

```
https://rsbjmunbljolbhhsdusk.supabase.co/functions/v1/asistente
```

El coste pasa a ser tuyo, por tokens. Una consulta ronda el céntimo, porque
lo pesado (los cálculos) no pasa por el modelo.

## Desarrollo

```bash
npm install
cp .env.example .env    # rellena los valores
npm run dev
```

## Estructura

```
src/SelectorVentilacion.jsx   la aplicación entera, con el catálogo dentro
src/main.jsx                  punto de entrada
supabase/functions/asistente  proxy opcional para la IA
.github/workflows/deploy.yml  construcción y publicación automáticas
```
