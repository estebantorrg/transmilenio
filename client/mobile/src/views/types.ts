export interface View {
  el: HTMLElement;
  onShow?: () => void;
  onHide?: () => void;
}
