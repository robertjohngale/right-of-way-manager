import * as geometryEngine from 'esri/geometry/geometryEngine';
import Polyline from 'esri/geometry/Polyline';
import Polygon from 'esri/geometry/Polygon';
import Point from 'esri/geometry/Point';

export interface VertexInfo {
  index: number;
  x: number;
  y: number;
  bearing: number;
  bearingDMS: string;
  bendAngle: number;
  bendDirection: string;
  segmentLength: number;
  distanceFromStart: number;
}

/**
 * Build a ROW polygon from a centerline with left and right widths
 */
export function buildRowPolygon(
  centerline: Polyline,
  leftWidth: number,
  rightWidth: number
): Polygon {
  // Convert widths from meters to map units if needed
  const leftOffset = geometryEngine.offset(centerline, leftWidth, 'meters', 'miter') as Polyline;
  const rightOffset = geometryEngine.offset(centerline, -rightWidth, 'meters', 'miter') as Polyline;

  if (!leftOffset || !rightOffset) {
    throw new Error('Failed to create offset lines');
  }

  // Get the path coordinates
  const leftPath = leftOffset.paths[0];
  const rightPath = rightOffset.paths[0];

  // Build polygon ring: left path forward + right path reversed + close
  const ring = [
    ...leftPath,
    ...rightPath.reverse(),
    leftPath[0] // Close the ring
  ];

  return new Polygon({
    rings: [ring],
    spatialReference: centerline.spatialReference
  });
}

/**
 * Compute vertex analytics for a polyline
 */
export function computeVertexAnalytics(polyline: Polyline): VertexInfo[] {
  const vertices: VertexInfo[] = [];
  const path = polyline.paths[0];

  if (!path || path.length < 2) {
    return vertices;
  }

  let cumulativeDistance = 0;

  for (let i = 0; i < path.length; i++) {
    const current = path[i];
    const prev = i > 0 ? path[i - 1] : null;
    const next = i < path.length - 1 ? path[i + 1] : null;

    // Calculate bearing to next point
    let bearing = 0;
    let segmentLength = 0;

    if (next) {
      const dx = next[0] - current[0];
      const dy = next[1] - current[1];
      bearing = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;

      // Calculate segment length
      const segment = new Polyline({
        paths: [[current, next]],
        spatialReference: polyline.spatialReference
      });
      segmentLength = geometryEngine.geodesicLength(segment, 'meters');
      cumulativeDistance += segmentLength;
    }

    // Calculate bend angle
    let bendAngle = 0;
    let bendDirection = 'N/A';

    if (prev && next) {
      const dx1 = current[0] - prev[0];
      const dy1 = current[1] - prev[1];
      const bearing1 = (Math.atan2(dx1, dy1) * 180 / Math.PI + 360) % 360;

      const dx2 = next[0] - current[0];
      const dy2 = next[1] - current[1];
      const bearing2 = (Math.atan2(dx2, dy2) * 180 / Math.PI + 360) % 360;

      let deflection = bearing2 - bearing1;
      if (deflection > 180) deflection -= 360;
      if (deflection < -180) deflection += 360;

      bendAngle = Math.abs(deflection);

      if (Math.abs(deflection) > 1) {
        bendDirection = deflection > 0 ? 'Left' : 'Right';
      } else {
        bendDirection = 'Straight';
      }
    } else if (i === 0) {
      bendDirection = 'Start';
    } else if (i === path.length - 1) {
      bendDirection = 'End';
    }

    vertices.push({
      index: i,
      x: current[0],
      y: current[1],
      bearing: bearing,
      bearingDMS: decimalToDMS(bearing),
      bendAngle: bendAngle,
      bendDirection: bendDirection,
      segmentLength: segmentLength,
      distanceFromStart: i === 0 ? 0 : cumulativeDistance - segmentLength
    });
  }

  return vertices;
}

/**
 * Convert decimal degrees to DMS format
 */
function decimalToDMS(decimal: number): string {
  const degrees = Math.floor(decimal);
  const minutesDecimal = (decimal - degrees) * 60;
  const minutes = Math.floor(minutesDecimal);
  const seconds = Math.floor((minutesDecimal - minutes) * 60);
  return `${degrees}° ${minutes}' ${seconds}"`;
}

/**
 * Calculate polygon area in square meters
 */
export function calculateArea(polygon: Polygon): number {
  return geometryEngine.geodesicArea(polygon, 'square-meters');
}

/**
 * Calculate polygon perimeter in meters
 */
export function calculatePerimeter(polygon: Polygon): number {
  return geometryEngine.geodesicLength(polygon, 'meters');
}
