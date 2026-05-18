import fs from 'fs';
fetch('https://gis.transmilenio.gov.co/arcgis/rest/services/Zonal/consulta_rutas_zonales/MapServer/1/query?where=1%3D1&outFields=*&f=json')
  .then(res => res.json())
  .then(data => {
    fs.writeFileSync('zonal_dump.json', JSON.stringify(data.features.slice(0, 50), null, 2));
    const fh = data.features.filter(f => f.attributes.codigo_definitivo_ruta_zonal?.includes('408') || f.attributes.codigo_definitivo_ruta_zonal?.includes('818') || f.attributes.codigo_definitivo_ruta_zonal?.includes('149'));
    console.log(fh.map(f => f.attributes));
  });
