/**
 * The legend a plano prints down its left edge, as Material Symbols.
 *
 * Drawn glyphs rather than words because these are the marks a rider matches
 * against the wall. The first pass drew them by hand and they were not
 * readable at plan size — so these are the real Material Symbols outlines,
 * vendored (Apache-2.0) rather than loaded from a font, so the drawing needs
 * no network and cannot render as empty boxes while a webfont arrives.
 *
 * Chosen for what is ACTUALLY at that spot in the station, not for the word:
 * a torniquete is a barrier you pass through, so it is `toll`, the gate;
 * a taquilla sells and tops up cards, so it is `confirmation_number`.
 * Material Symbols has no turnstile, no bridge and no emergency-exit glyph —
 * the first two are handled here and the bridge is drawn as a labelled
 * structure instead, which is how the sheets mark it anyway.
 */
export const ICONOS: Record<string, { label: string; material: string; vb: string; d: string[] }> = {
  taquilla: {
    label: 'Taquilla',
    material: 'confirmation_number',
    vb: '0 -960 960 960',
    d: [
      'M480-280q17 0 28.5-11.5T520-320q0-17-11.5-28.5T480-360q-17 0-28.5 11.5T440-320q0 17 11.5 28.5T480-280Zm0-160q17 0 28.5-11.5T520-480q0-17-11.5-28.5T480-520q-17 0-28.5 11.5T440-480q0 17 11.5 28.5T480-440Zm0-160q17 0 28.5-11.5T520-640q0-17-11.5-28.5T480-680q-17 0-28.5 11.5T440-640q0 17 11.5 28.5T480-600Zm320 440H160q-33 0-56.5-23.5T80-240v-160q33 0 56.5-23.5T160-480q0-33-23.5-56.5T80-560v-160q0-33 23.5-56.5T160-800h640q33 0 56.5 23.5T880-720v160q-33 0-56.5 23.5T800-480q0 33 23.5 56.5T880-400v160q0 33-23.5 56.5T800-160Zm0-80v-102q-37-22-58.5-58.5T720-480q0-43 21.5-79.5T800-618v-102H160v102q37 22 58.5 58.5T240-480q0 43-21.5 79.5T160-342v102h640ZM480-480Z',
    ],
  },
  torniquete: {
    label: 'Torniquetes',
    material: 'toll',
    vb: '0 -960 960 960',
    d: [
      'M373-253q-93-93-93-227t93-227q93-93 227-93t227 93q93 93 93 227t-93 227q-93 93-227 93t-227-93Zm-93 83q-106-28-173-114T40-480q0-110 67-196t173-114v84q-72 25-116 87t-44 139q0 77 44 139t116 87v84Zm320-310Zm170 170q70-70 70-170t-70-170q-70-70-170-70t-170 70q-70 70-70 170t70 170q70 70 170 70t170-70Z',
    ],
  },
  rampa: {
    label: 'Rampa peatonal',
    material: 'accessible',
    vb: '0 -960 960 960',
    d: [
      'M423.5-743.5Q400-767 400-800t23.5-56.5Q447-880 480-880t56.5 23.5Q560-833 560-800t-23.5 56.5Q513-720 480-720t-56.5-23.5ZM680-80v-200H480q-33 0-56.5-23.5T400-360v-240q0-33 23.5-56.5T480-680q24 0 41.5 10.5T559-636q55 66 99.5 90.5T760-520v80q-53 0-107-23t-93-55v138h120q33 0 56.5 23.5T760-300v220h-80Zm-280 0q-83 0-141.5-58.5T200-280q0-72 45.5-127T360-476v82q-35 14-57.5 44.5T280-280q0 50 35 85t85 35q39 0 69.5-22.5T514-240h82q-14 69-69 114.5T400-80Z',
    ],
  },
  escalera: {
    label: 'Escalera peatonal',
    material: 'stairs',
    vb: '0 -960 960 960',
    d: [
      'M240-240h177v-133h103v-133h103v-134h97v-80H543v133H440v133H337v134h-97v80Zm-40 120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h560q33 0 56.5 23.5T840-760v560q0 33-23.5 56.5T760-120H200Zm0-80h560v-560H200v560Zm0-560v560-560Z',
    ],
  },
  ascensor: {
    label: 'Ascensor prioritario',
    material: 'elevator',
    vb: '0 -960 960 960',
    d: [
      'M280-240h120v-160h40v-100q0-33-23.5-56.5T360-580h-40q-33 0-56.5 23.5T240-500v100h40v160Zm95.5-394.5Q390-649 390-670t-14.5-35.5Q361-720 340-720t-35.5 14.5Q290-691 290-670t14.5 35.5Q319-620 340-620t35.5-14.5ZM520-520h200L620-680 520-520Zm100 240 100-160H520l100 160ZM200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h560q33 0 56.5 23.5T840-760v560q0 33-23.5 56.5T760-120H200Zm0-80h560v-560H200v560Zm0 0v-560 560Z',
    ],
  },
  emergencia: {
    label: 'Salida de emergencia',
    material: 'directions_run',
    vb: '0 -960 960 960',
    d: [
      'M520-40v-240l-84-80-40 176-276-56 16-80 192 40 64-324-72 28v136h-80v-188l158-68q35-15 51.5-19.5T480-720q21 0 39 11t29 29l40 64q26 42 70.5 69T760-520v80q-66 0-123.5-27.5T540-540l-24 120 84 80v300h-80Zm-36.5-723.5Q460-787 460-820t23.5-56.5Q507-900 540-900t56.5 23.5Q620-853 620-820t-23.5 56.5Q573-740 540-740t-56.5-23.5Z',
    ],
  },
  bici: {
    label: 'TransMiBici',
    material: 'pedal_bike',
    vb: '0 -960 960 960',
    d: [
      'M200-160q-85 0-142.5-57.5T0-360q0-85 58.5-142.5T200-560q77 0 129.5 46T396-400h26l-72-200h-70v-80h200v80h-44l14 40h192l-58-160H480v-80h104q26 0 46.5 14t29.5 38l68 186h32q83 0 141.5 58.5T960-362q0 84-58 143t-142 59q-72 0-126.5-45T564-320H396q-14 69-68 114.5T200-160Zm0-80q41 0 70.5-22.5T312-320H200v-80h112q-12-36-41.5-58T200-480q-51 0-85.5 34.5T80-360q0 50 34.5 85t85.5 35Zm308-160h56q5-23 13.5-43t22.5-37H478l30 80Zm252 160q51 0 85.5-35t34.5-85q0-51-34.5-85.5T760-480h-4l40 106-76 28-38-106q-20 17-31 40t-11 52q0 50 34.5 85t85.5 35ZM196-360Zm564 0Z',
    ],
  },
  cable: {
    label: 'Conexión TransMiCable',
    material: 'cable_car',
    vb: '0 -960 960 960',
    d: [
      'M280-120v-40H120v-80h40v-480h-40v-80h133l27-80h400l27 80h133v80h-40v480h40v80H680v40H280Zm-40-120h480v-200H240v200Zm282.5-57.5Q540-315 540-340t-17.5-42.5Q505-400 480-400t-42.5 17.5Q420-365 420-340t17.5 42.5Q455-280 480-280t42.5-17.5ZM240-520h120v-140q0-25-17.5-42.5T300-720q-25 0-42.5 17.5T240-660v140Zm180 0h120v-140q0-25-17.5-42.5T480-720q-25 0-42.5 17.5T420-660v140Zm180 0h120v-140q0-25-17.5-42.5T660-720q-25 0-42.5 17.5T600-660v140Zm-360 80h480-480Z',
    ],
  },
  zonal: {
    label: 'Conexión con servicio zonal',
    material: 'directions_bus',
    vb: '0 -960 960 960',
    d: [
      'M240-120q-17 0-28.5-11.5T200-160v-82q-18-20-29-44.5T160-340v-380q0-83 77-121.5T480-880q172 0 246 37t74 123v380q0 29-11 53.5T760-242v82q0 17-11.5 28.5T720-120h-40q-17 0-28.5-11.5T640-160v-40H320v40q0 17-11.5 28.5T280-120h-40Zm242-640h224-448 224Zm158 280H240h480-80Zm-400-80h480v-120H240v120Zm142.5 222.5Q400-355 400-380t-17.5-42.5Q365-440 340-440t-42.5 17.5Q280-405 280-380t17.5 42.5Q315-320 340-320t42.5-17.5Zm280 0Q680-355 680-380t-17.5-42.5Q645-440 620-440t-42.5 17.5Q560-405 560-380t17.5 42.5Q595-320 620-320t42.5-17.5ZM258-760h448q-15-17-64.5-28.5T482-800q-107 0-156.5 12.5T258-760Zm62 480h320q33 0 56.5-23.5T720-360v-120H240v120q0 33 23.5 56.5T320-280Z',
    ],
  },
};
