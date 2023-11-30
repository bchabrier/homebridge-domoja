
export type Device = {
    id: string; //'piscine.filtration-duration',
    path: string; // 'piscine.filtration-duration',
    state: string | number | Date;
    lastUpdateDate: Date; // '2023-11-29T00:26:16.347Z',
    name: string; // 'Durée de la filtration (heures)',
    type: string; // 'variable',
    source: string; // 'default',
    widget: string; // 'text!{value, number, .##}',
    tags: string; // ' piscine, '
  };

  export function replaceDates(o: { [key: string]: any }) {
    Object.keys(o).forEach(key => {
        const value = o[key];

        if (typeof value === 'string') {
            const a = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z/.test(value);
            if (a) {
                o[key] = new Date(value);
            }
        } else if (value && typeof value === 'object') {
            replaceDates(o[key]);
        }
    });
}
