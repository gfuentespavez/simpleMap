let collapsed = $state(false);

export const sidebar = {
  get collapsed() { return collapsed; },
  set collapsed(v) { collapsed = v; },
  collapse() { collapsed = true; },
  expand()   { collapsed = false; },
  toggle()   { collapsed = !collapsed; },
};
