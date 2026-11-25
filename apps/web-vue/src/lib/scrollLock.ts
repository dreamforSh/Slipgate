/**
 * Reference-counted body scroll lock shared by modals and drawers, so closing one overlay
 * while another is still open keeps the page locked. The scrollbar's width is padded back
 * onto <body> while locked, so content does not shift sideways when the bar disappears.
 */
let locks = 0;

export function lockBodyScroll(): void {
  if (locks++ > 0) return;
  const gap = window.innerWidth - document.documentElement.clientWidth;
  document.body.style.overflow = "hidden";
  if (gap > 0) document.body.style.paddingRight = `${gap}px`;
}

export function unlockBodyScroll(): void {
  if (locks === 0) return;
  if (--locks > 0) return;
  document.body.style.overflow = "";
  document.body.style.paddingRight = "";
}
