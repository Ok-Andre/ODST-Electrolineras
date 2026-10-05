// Coordenadas centrales de CDMX
const map = L.map('map').setView([19.38, -99.15], 11);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '© OpenStreetMap contributors'
}).addTo(map);

// ---------- Leyenda ----------
const legend = L.control({ position: 'bottomright' });
legend.onAdd = function () {
    const div = L.DomUtil.create('div', 'legend');
    div.innerHTML = `
        <div><i style="background:#2ca25f"></i>Alta (top 20 %)</div>
        <div><i style="background:#ffeda0"></i>Media (40–80 %)</div>
        <div><i style="background:#de2d26"></i>Baja (40 % inferior)</div>`;
    return div;
};
legend.addTo(map);

// ---------- Utilidades ----------
// pct = percentil 0-1 (no el valor crudo)
function getColor(pct) {
    if (pct > 0.8) return '#2ca25f';   // Verde (alta)
    if (pct > 0.4) return '#ffeda0';   // Amarillo (media)
    return '#de2d26';                  // Rojo (baja)
}

// Calcula el percentil de \`key\` entre todos los polígonos y lo guarda en _pct
function addPct(data, key) {
    const vals = data.features
        .map(f => f.properties[key] ?? 0)
        .sort((a, b) => a - b);
    const n = Math.max(vals.length - 1, 1);
    data.features.forEach(f => {
        const v = f.properties[key] ?? 0;
        // primer índice con valor >= v (los empates comparten percentil)
        let lo = 0, hi = vals.length;
        while (lo < hi) {
            const m = (lo + hi) >> 1;
            if (vals[m] < v) lo = m + 1; else hi = m;
        }
        f.properties._pct = lo / n;
    });
}

function style(feature) {
    return {
        fillColor: getColor(feature.properties._pct ?? 0),
        weight: 1,
        opacity: 1,
        color: 'white',
        fillOpacity: 0.7
    };
}

const btnIds = ['btn-original', 'btn-no-destinos', 'btn-2030', 'btn-2035'];

function setActive(id) {
    btnIds.forEach(b => document.getElementById(b).classList.remove('active'));
    document.getElementById(id).classList.add('active');
}

// ---------- Mapas de viabilidad (originales) ----------
let isSinDestinosMap = false;
let currentLayer = null;

function onEachFeature(feature, layer) {
    if (feature.properties) {
        const props = feature.properties;
        const alcaldia = props.NOM_MUN || 'Desconocida';
        const viviendasAuto = (props.VPH_AUTOM !== null && props.VPH_AUTOM !== undefined)
            ? props.VPH_AUTOM : 'N/D';
        const viabilidad = (props.viabilidad !== null && props.viabilidad !== undefined)
            ? props.viabilidad.toFixed(4) : 'N/D';
        const pct = (props._pct !== undefined)
            ? Math.round(props._pct * 100) : 'N/D';

        let popupContent = `
            <div class="popup-title">Alcaldía: ${alcaldia}</div>
            <div><b>Viviendas con auto:</b> ${viviendasAuto}</div>
        `;

        if (!isSinDestinosMap) {
            const destinos = (props.destinos_raw !== null && props.destinos_raw !== undefined)
                ? props.destinos_raw : 'N/D';
            popupContent += `<div><b>Destinos contados:</b> ${destinos}</div>`;
        }

        popupContent += `<div><b>Puntaje de viabilidad:</b> ${viabilidad}</div>`;
        popupContent += `<div><b>Percentil:</b> ${pct}</div>`;

        layer.bindPopup(popupContent);
    }
}

function loadMapData(filename) {
    if (currentLayer) {
        map.removeLayer(currentLayer);
    }
    fetch(filename)
        .then(response => {
            if (!response.ok) {
                throw new Error('Error al cargar el archivo GeoJSON');
            }
            return response.json();
        })
        .then(data => {
            addPct(data, 'viabilidad');
            currentLayer = L.geoJSON(data, {
                style: style,
                onEachFeature: onEachFeature
            }).addTo(map);
            if (chargersLayer) chargersLayer.bringToFront();
        })
        .catch(error => {
            console.error('Hubo un problema con la petición Fetch:', error);
        });
}

// ---------- Predicciones 2030 / 2035 (modelo) ----------
// Se carga una sola vez; la llave "zona" == CVEGEO del polígono.
// Se guarda la promesa para que un clic rápido espere a que termine la carga.
const PRED_PROMISE = fetch('./predicciones.json')
    .then(r => {
        if (!r.ok) throw new Error('No se encontró predicciones.json');
        return r.json();
    })
    .catch(e => {
        console.error('No se pudo cargar predicciones.json:', e);
        return [];
    });

const mxn = n => '$' + Math.round(n).toLocaleString('es-MX');

async function loadPrediction(año) {
    if (currentLayer) {
        map.removeLayer(currentLayer);
        currentLayer = null;
    }

    try {
        const PRED = await PRED_PROMISE;

        // Índice rápido: CVEGEO -> predicción de ese año
        const porZona = {};
        PRED.filter(r => r['año'] === año).forEach(r => { porZona[r.zona] = r; });

        const resp = await fetch('./viabilidad_cdmx_v2.geojson');
        if (!resp.ok) throw new Error('Error al cargar el GeoJSON');
        const geo = await resp.json();

        // score_viabilidad ya es un percentil (0-1) calculado en export.py
        geo.features.forEach(f => {
            const p = porZona[f.properties.CVEGEO];
            f.properties._pct = p ? p.score_viabilidad : 0;
        });

        currentLayer = L.geoJSON(geo, {
            style: style,
            onEachFeature: (f, layer) => {
                const p = porZona[f.properties.CVEGEO];
                if (!p) return;
                layer.bindPopup(`
                    <div class="popup-title">${p.alcaldia} — ${año}</div>
                    <div><b>Ganancia máx:</b> ${mxn(p.ganancia_max)}</div>
                    <div><b>Ganancia mín:</b> ${mxn(p.ganancia_min)}</div>
                    <div><b>Percentil de viabilidad:</b> ${(p.score_viabilidad * 100).toFixed(0)}</div>
                `);
            }
        }).addTo(map);
        if (chargersLayer) chargersLayer.bringToFront();
    } catch (e) {
        console.error('Error al cargar la predicción:', e);
    }
}

// ---------- Botones ----------
document.getElementById('btn-original').addEventListener('click', function () {
    setActive('btn-original');
    isSinDestinosMap = false;
    loadMapData('./viabilidad_cdmx_v2.geojson');
});

document.getElementById('btn-no-destinos').addEventListener('click', function () {
    setActive('btn-no-destinos');
    isSinDestinosMap = true;
    loadMapData('./viabilidad_cdmx_v2_no_destinos.geojson');
});

document.getElementById('btn-2030').addEventListener('click', function () {
    setActive('btn-2030');
    loadPrediction(2030);
});

document.getElementById('btn-2035').addEventListener('click', function () {
    setActive('btn-2035');
    loadPrediction(2035);
});

// ---------- Electrolineras ----------
let chargersLayer = null;
let allChargersData = null;
let cdmxPolygonsData = null;

async function loadChargers() {
    try {
        if (!allChargersData) {
            const response = await fetch('../datasets/all_chargers_geo.json');
            if (!response.ok) throw new Error('Error al cargar electrolineras');
            allChargersData = await response.json();
        }

        if (!cdmxPolygonsData) {
            const response = await fetch('./viabilidad_cdmx_v2.geojson');
            if (!response.ok) throw new Error('Error al cargar polígonos CDMX');
            cdmxPolygonsData = await response.json();
        }

        // Filtrar usando Turf.js para dejar solo los puntos que caen dentro de CDMX
        const filteredChargers = turf.pointsWithinPolygon(allChargersData, cdmxPolygonsData);

        if (chargersLayer) {
            map.removeLayer(chargersLayer);
        }
        
        chargersLayer = L.geoJSON(filteredChargers, {
            pointToLayer: function (feature, latlng) {
                let color = 'gray';
                if (feature.properties.red === 'Tesla') color = 'red';
                else if (feature.properties.red === 'Evergo') color = 'green';
                else if (feature.properties.red === 'PlugShare') color = 'blue';

                return L.circleMarker(latlng, {
                    radius: 5,
                    fillColor: color,
                    color: '#000',
                    weight: 1,
                    opacity: 1,
                    fillOpacity: 0.9
                });
            },
            onEachFeature: function (feature, layer) {
                const props = feature.properties;
                const nombre = props.nombre || 'Desconocido';
                const marca = props.red || 'Desconocida';
                const puertos = props.n_puertos || 'N/D';

                const popupContent = `
                    <div class="popup-title">Electrolinera</div>
                    <div><b>Nombre:</b> ${nombre}</div>
                    <div><b>Marca:</b> ${marca}</div>
                    <div><b>Número de puertos:</b> ${puertos}</div>
                `;
                layer.bindPopup(popupContent);
            }
        });
        chargersLayer.addTo(map);
        
        // Asegurar que los puntos queden encima de los polígonos
        chargersLayer.bringToFront();
    } catch (error) {
        console.error('Hubo un problema al cargar electrolineras:', error);
    }
}

// Mapa por defecto
loadMapData('./viabilidad_cdmx_v2.geojson');
loadChargers();

// Toggle Slide-bar
document.getElementById('toggle-sidebar').addEventListener('click', function() {
    const sidebar = document.getElementById('sidebar');
    if (sidebar.classList.contains('open')) {
        sidebar.classList.remove('open');
        this.innerHTML = '◀';
    } else {
        sidebar.classList.add('open');
        this.innerHTML = '▶';
    }
});
