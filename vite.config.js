import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/* En GitHub Pages de proyecto el sitio cuelga de /<repositorio>/, no de
   la raíz. Si base no coincide, la página carga en blanco porque busca
   los archivos en el sitio equivocado. El flujo de despliegue inyecta
   VITE_BASE con el nombre real del repositorio. */
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE || "/",
});
