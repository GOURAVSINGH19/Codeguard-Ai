// Server-safe theme constants (no React imports) so the root layout can use them.
export const THEME_KEY = "cg:theme";
export const MEDIA = "(prefers-color-scheme: dark)";

/**
 * Runs inline in <head> before first paint so the page never flashes the
 * wrong theme. Must stay self-contained (it is stringified).
 */
export const THEME_INIT_SCRIPT = `(function(){try{var p=localStorage.getItem("${THEME_KEY}");var d=p==="dark"||(p!=="light"&&matchMedia("${MEDIA}").matches);var r=document.documentElement;r.classList.toggle("dark",d);r.style.colorScheme=d?"dark":"light";}catch(e){}})();`;
