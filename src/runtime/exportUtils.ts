import Polyline from 'esri/geometry/Polyline';
import Polygon from 'esri/geometry/Polygon';
import { VertexInfo } from './geometryUtils';

/**
 * Export geometry to GeoJSON
 */
export function exportGeoJSON(geometry: Polyline | Polygon, filename: string): void {
  let geojson: any;

  if (geometry.type === 'polyline') {
    const polyline = geometry as Polyline;
    geojson = {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: polyline.paths[0]
      },
      properties: {}
    };
  } else if (geometry.type === 'polygon') {
    const polygon = geometry as Polygon;
    geojson = {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: polygon.rings
      },
      properties: {}
    };
  }

  downloadJSON(geojson, filename);
}

/**
 * Export vertex analytics to CSV
 */
export function exportVerticesCSV(vertices: VertexInfo[], filename: string): void {
  const headers = [
    'Index',
    'X',
    'Y',
    'Bearing',
    'Bearing DMS',
    'Bend Angle',
    'Bend Direction',
    'Segment Length (m)',
    'Distance From Start (m)'
  ];

  const rows = vertices.map(v => [
    v.index,
    v.x.toFixed(6),
    v.y.toFixed(6),
    v.bearing.toFixed(2),
    v.bearingDMS,
    v.bendAngle.toFixed(2),
    v.bendDirection,
    v.segmentLength.toFixed(2),
    v.distanceFromStart.toFixed(2)
  ]);

  const csv = [
    headers.join(','),
    ...rows.map(row => row.join(','))
  ].join('\n');

  downloadText(csv, filename, 'text/csv');
}

/**
 * Download JSON data as a file
 */
function downloadJSON(data: any, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Download text data as a file
 */
function downloadText(text: string, filename: string, mimeType: string): void {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
