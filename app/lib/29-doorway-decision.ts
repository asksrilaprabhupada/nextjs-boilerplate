/**
 * 29-doorway-decision.ts — Show the doorway, or skip it, before the first paint
 *
 * The doorway (components/cinematic/16-doorway.tsx) shows on arrival at "/"
 * only: `?entrance=0` skips it, and it shows at most once a day per device
 * (the local date is kept in localStorage, inside try/catch — a blocked
 * storage simply means it shows). The decision runs as an inline script in
 * app/layout.tsx, before any page content is parsed, and is written to
 * <html data-door="show" | "skip">; app/redesign.css hides the doorway unless
 * it says "show". So a skipped doorway never flashes and never loads a photo.
 */
export const DOORWAY_DATE_KEY = "asp-door-date";

export const DOORWAY_DECISION_SCRIPT = `(function(){try{if(location.pathname!=='/')return;var d=document.documentElement,s='show';if(new URLSearchParams(location.search).get('entrance')==='0'){s='skip'}else{var t=new Date(),k=t.getFullYear()+'-'+(t.getMonth()+1)+'-'+t.getDate();try{if(localStorage.getItem('${DOORWAY_DATE_KEY}')===k){s='skip'}else{localStorage.setItem('${DOORWAY_DATE_KEY}',k)}}catch(e){}}d.setAttribute('data-door',s)}catch(e){}})();`;
