export type Ocupacion = 'VACIO' | 'MEDIO' | 'LLENO';
export declare function ocupacionDe(bus: unknown): Ocupacion | null;
export declare function ocupacionTexto(nivel: Ocupacion | null | undefined): string | null;
