/** @jsx jsx */
import { React, AllWidgetProps, jsx } from 'jimu-core';
import { JimuMapView, MapViewManager } from 'jimu-arcgis';
import { Button, Select, Option, TextInput, Label, Modal, ModalHeader, ModalBody } from 'jimu-ui';
import GraphicsLayer from 'esri/layers/GraphicsLayer';
import SketchViewModel from 'esri/widgets/Sketch/SketchViewModel';
import Draw from 'esri/views/draw/Draw';
import Graphic from 'esri/Graphic';
import Polyline from 'esri/geometry/Polyline';
import Polygon from 'esri/geometry/Polygon';
import SimpleLineSymbol from 'esri/symbols/SimpleLineSymbol';
import SimpleFillSymbol from 'esri/symbols/SimpleFillSymbol';
import * as geometryEngine from 'esri/geometry/geometryEngine';
import * as reactiveUtils from 'esri/core/reactiveUtils';
import { buildRowPolygon, computeVertexAnalytics, calculateArea, calculatePerimeter, VertexInfo } from './geometryUtils';
import { exportGeoJSON, exportVerticesCSV } from './exportUtils';

interface LineRecord {
  id: number;
  project: string;
  geometry: Polyline;
  leftWidth: number;
  rightWidth: number;
  totalWidth: number;
  createdDate: string;
}

interface PolygonRecord {
  id: number;
  lineId: number;
  project: string;
  geometry: Polygon;
  area: number;
  perimeter: number;
  createdDate: string;
}

interface State {
  jimuMapView: JimuMapView;
  mapReady: boolean;
  project: string;
  leftWidth: number;
  rightWidth: number;
  mode: 'draw' | 'select';
  drawingMethod: 'sketch' | 'realtime';
  selectedLayerId: string;
  lines: LineRecord[];
  polygons: PolygonRecord[];
  isDrawing: boolean;
  nextLineId: number;
  nextPolygonId: number;
  verticesModalOpen: boolean;
  currentVertices: VertexInfo[];
  currentLineId: number;
}

export default class Widget extends React.PureComponent<AllWidgetProps<any>, State> {
  private centerlineLayer: GraphicsLayer;
  private rowLayer: GraphicsLayer;
  private previewLayer: GraphicsLayer;
  private sketchViewModel: SketchViewModel;
  private viewManager: any;

  constructor(props) {
    super(props);

    this.viewManager = MapViewManager.getInstance();
    const mapView = this.viewManager.getJimuMapViewById(this.viewManager.getAllJimuMapViewIds()[0]);

    this.state = {
      jimuMapView: mapView,
      mapReady: false,
      project: '',
      leftWidth: 50,
      rightWidth: 50,
      mode: 'draw',
      drawingMethod: 'sketch',
      selectedLayerId: '',
      lines: [],
      polygons: [],
      isDrawing: false,
      nextLineId: 1,
      nextPolygonId: 1,
      verticesModalOpen: false,
      currentVertices: [],
      currentLineId: null
    };
  }

  componentDidMount() {
    const { jimuMapView } = this.state;
    if (jimuMapView) {
      this.initializeMap(jimuMapView);
    }
  }

  componentWillUnmount() {
    if (this.sketchViewModel) {
      this.sketchViewModel.destroy();
    }
  }

  initializeMap = (jimuMapView: JimuMapView) => {
    reactiveUtils
      .whenOnce(() => jimuMapView.view.ready)
      .then(() => {
        this.setState({ mapReady: true });

        // Create graphics layers
        this.centerlineLayer = new GraphicsLayer({
          id: 'CenterlineLayer',
          title: 'Centerlines'
        });

        this.rowLayer = new GraphicsLayer({
          id: 'ROWLayer',
          title: 'Right of Way Polygons'
        });

        this.previewLayer = new GraphicsLayer({
          id: 'PreviewLayer',
          title: 'Drawing Preview'
        });

        jimuMapView.view.map.add(this.centerlineLayer);
        jimuMapView.view.map.add(this.rowLayer);
        jimuMapView.view.map.add(this.previewLayer);

        // Initialize SketchViewModel
        this.sketchViewModel = new SketchViewModel({
          view: jimuMapView.view,
          layer: this.centerlineLayer,
          creationMode: 'single'
        });

        this.sketchViewModel.on('create', (event) => {
          if (event.state === 'complete') {
            const geometry = event.graphic.geometry as Polyline;
            this.addLine(geometry);
            this.setState({ isDrawing: false });
          }
        });
      });
  };

  handleDrawLine = () => {
    if (!this.state.project) {
      alert('Please enter a project name first');
      return;
    }

    this.setState({ isDrawing: true });

    if (this.state.drawingMethod === 'realtime') {
      this.startRealtimeDrawing();
    } else {
      this.sketchViewModel.create('polyline', { mode: 'click' });
    }
  };

  startRealtimeDrawing = () => {
    const draw = new Draw({ view: this.state.jimuMapView.view });
    this.previewLayer.removeAll();

    const action = draw.create('polyline');

    action.on([
      'vertex-add',
      'vertex-remove',
      'cursor-update',
      'redo',
      'undo',
      'draw-complete'
    ], (event) => this.updateRealtimePreview(event));
  };

  updateRealtimePreview = (event: any) => {
    if (event.vertices.length > 1) {
      this.previewLayer.removeAll();

      // Create centerline geometry
      const centerlineGeometry = new Polyline({
        paths: [event.vertices],
        spatialReference: this.state.jimuMapView.view.spatialReference
      });

      // Create centerline graphic
      const centerlineSymbol = new SimpleLineSymbol({
        color: [0, 112, 255],
        width: 3
      });

      const centerlineGraphic = new Graphic({
        geometry: centerlineGeometry,
        symbol: centerlineSymbol
      });

      // Create ROW buffer preview
      try {
        const rowPolygon = buildRowPolygon(
          centerlineGeometry,
          this.state.leftWidth,
          this.state.rightWidth
        );

        const fillSymbol = new SimpleFillSymbol({
          color: [255, 0, 0, 0.3],
          outline: {
            color: [255, 0, 0],
            width: 2
          }
        });

        const rowGraphic = new Graphic({
          geometry: rowPolygon,
          symbol: fillSymbol
        });

        this.previewLayer.addMany([rowGraphic, centerlineGraphic]);
      } catch (error) {
        // Just show centerline if ROW creation fails during preview
        this.previewLayer.add(centerlineGraphic);
      }

      // On draw-complete, save the line
      if (event.type === 'draw-complete') {
        this.previewLayer.removeAll();
        this.addLine(centerlineGeometry);
        this.setState({ isDrawing: false });
      }
    }
  };

  addLine = (geometry: Polyline) => {
    const { project, leftWidth, rightWidth, nextLineId, lines } = this.state;
    const totalWidth = leftWidth + rightWidth;

    const newLine: LineRecord = {
      id: nextLineId,
      project,
      geometry,
      leftWidth,
      rightWidth,
      totalWidth,
      createdDate: new Date().toLocaleString()
    };

    // Add graphic to map
    const lineSymbol = new SimpleLineSymbol({
      color: [0, 112, 255],
      width: 3
    });

    const graphic = new Graphic({
      geometry,
      symbol: lineSymbol,
      attributes: { id: nextLineId, type: 'centerline' }
    });

    this.centerlineLayer.add(graphic);

    this.setState({
      lines: [...lines, newLine],
      nextLineId: nextLineId + 1
    }, () => {
      // Automatically build ROW polygon after adding line
      this.buildROW(nextLineId);
    });
  };

  buildROW = (lineId: number) => {
    const line = this.state.lines.find(l => l.id === lineId);
    if (!line) return;

    try {
      const polygon = buildRowPolygon(line.geometry, line.leftWidth, line.rightWidth);
      const area = calculateArea(polygon);
      const perimeter = calculatePerimeter(polygon);

      const newPolygon: PolygonRecord = {
        id: this.state.nextPolygonId,
        lineId: line.id,
        project: line.project,
        geometry: polygon,
        area,
        perimeter,
        createdDate: new Date().toLocaleString()
      };

      // Add graphic to map
      const fillSymbol = new SimpleFillSymbol({
        color: [255, 0, 0, 0.2],
        outline: {
          color: [255, 0, 0],
          width: 2
        }
      });

      const graphic = new Graphic({
        geometry: polygon,
        symbol: fillSymbol,
        attributes: { id: this.state.nextPolygonId, lineId, type: 'row' }
      });

      this.rowLayer.add(graphic);

      this.setState({
        polygons: [...this.state.polygons, newPolygon],
        nextPolygonId: this.state.nextPolygonId + 1
      });
    } catch (error) {
      alert(`Error creating ROW: ${error.message}`);
    }
  };

  deleteLine = (lineId: number) => {
    // Remove from state
    this.setState({
      lines: this.state.lines.filter(l => l.id !== lineId)
    });

    // Remove graphic from map
    const graphicsToRemove = this.centerlineLayer.graphics.filter(
      g => g.attributes?.id === lineId
    );
    this.centerlineLayer.removeMany(graphicsToRemove.toArray());
  };

  deletePolygon = (polygonId: number) => {
    this.setState({
      polygons: this.state.polygons.filter(p => p.id !== polygonId)
    });

    const graphicsToRemove = this.rowLayer.graphics.filter(
      g => g.attributes?.id === polygonId
    );
    this.rowLayer.removeMany(graphicsToRemove.toArray());
  };

  zoomToLine = (lineId: number) => {
    const line = this.state.lines.find(l => l.id === lineId);
    if (line && this.state.jimuMapView) {
      this.state.jimuMapView.view.goTo(line.geometry);
    }
  };

  zoomToPolygon = (polygonId: number) => {
    const polygon = this.state.polygons.find(p => p.id === polygonId);
    if (polygon && this.state.jimuMapView) {
      this.state.jimuMapView.view.goTo(polygon.geometry);
    }
  };

  showVertices = (lineId: number) => {
    const line = this.state.lines.find(l => l.id === lineId);
    if (line) {
      const vertices = computeVertexAnalytics(line.geometry);
      this.setState({
        verticesModalOpen: true,
        currentVertices: vertices,
        currentLineId: lineId
      });
    }
  };

  exportLineGeoJSON = (lineId: number) => {
    const line = this.state.lines.find(l => l.id === lineId);
    if (line) {
      exportGeoJSON(line.geometry, `${line.project}_line_${lineId}.geojson`);
    }
  };

  exportPolygonGeoJSON = (polygonId: number) => {
    const polygon = this.state.polygons.find(p => p.id === polygonId);
    if (polygon) {
      exportGeoJSON(polygon.geometry, `${polygon.project}_polygon_${polygonId}.geojson`);
    }
  };

  exportVertices = () => {
    const { currentVertices, currentLineId } = this.state;
    const line = this.state.lines.find(l => l.id === currentLineId);
    if (currentVertices && line) {
      exportVerticesCSV(currentVertices, `${line.project}_vertices_${currentLineId}.csv`);
    }
  };

  render() {
    const {
      mapReady,
      project,
      leftWidth,
      rightWidth,
      mode,
      isDrawing,
      lines,
      polygons,
      verticesModalOpen,
      currentVertices
    } = this.state;

    if (!this.state.jimuMapView) {
      return (
        <div className="widget-row-manager jimu-widget" style={{ padding: '10px' }}>
          <div style={{ padding: '10px', background: '#ffebee', borderRadius: '4px', color: '#c62828' }}>
            <strong>No Map Found:</strong>
            <br />
            Please add a Map widget to your page first.
          </div>
        </div>
      );
    }

    return (
      <div className="widget-row-manager jimu-widget" style={{ padding: '15px', overflow: 'auto', maxHeight: '100%' }}>
        <h3 style={{ marginBottom: '15px' }}>Right of Way Manager</h3>

        {/* Input Section */}
        <div style={{ marginBottom: '20px', padding: '10px', background: '#f5f5f5', borderRadius: '4px' }}>
          <Label>
            Project Name *
            <TextInput
              value={project}
              onChange={(e) => this.setState({ project: e.target.value })}
              placeholder="Enter project name"
              style={{ width: '100%', marginBottom: '10px' }}
            />
          </Label>

          <Label>
            Mode
            <Select
              value={mode}
              onChange={(e) => this.setState({ mode: e.target.value as 'draw' | 'select' })}
              style={{ width: '100%', marginBottom: '10px' }}
            >
              <Option value="draw">Draw Centerline</Option>
              <Option value="select">Select Existing Line</Option>
            </Select>
          </Label>

          <Label>
            Drawing Method
            <Select
              value={this.state.drawingMethod}
              onChange={(e) => this.setState({ drawingMethod: e.target.value as 'sketch' | 'realtime' })}
              style={{ width: '100%', marginBottom: '10px' }}
            >
              <Option value="sketch">Standard (Click to Complete)</Option>
              <Option value="realtime">Real-time Preview</Option>
            </Select>
          </Label>

          <div style={{ display: 'flex', gap: '10px', marginBottom: '10px' }}>
            <Label style={{ flex: 1 }}>
              Left Width (m)
              <TextInput
                type="number"
                value={leftWidth}
                onChange={(e) => this.setState({ leftWidth: parseFloat(e.target.value) || 0 })}
                style={{ width: '100%' }}
              />
            </Label>
            <Label style={{ flex: 1 }}>
              Right Width (m)
              <TextInput
                type="number"
                value={rightWidth}
                onChange={(e) => this.setState({ rightWidth: parseFloat(e.target.value) || 0 })}
                style={{ width: '100%' }}
              />
            </Label>
          </div>

          <Button
            onClick={this.handleDrawLine}
            disabled={isDrawing || !project}
            style={{ width: '100%' }}
          >
            {isDrawing ? 'Drawing...' : 'Add Centerline'}
          </Button>
        </div>

        {/* Lines Table */}
        <div style={{ marginBottom: '20px' }}>
          <h4>Centerlines ({lines.length})</h4>
          <div style={{ overflowX: 'auto', maxHeight: '300px', overflowY: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
              <thead>
                <tr style={{ background: '#e0e0e0', position: 'sticky', top: 0 }}>
                  <th style={{ padding: '8px', border: '1px solid #ccc' }}>ID</th>
                  <th style={{ padding: '8px', border: '1px solid #ccc' }}>Project</th>
                  <th style={{ padding: '8px', border: '1px solid #ccc' }}>Width (L/R)</th>
                  <th style={{ padding: '8px', border: '1px solid #ccc' }}>Created</th>
                  <th style={{ padding: '8px', border: '1px solid #ccc' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {lines.map(line => (
                  <tr key={line.id}>
                    <td style={{ padding: '4px', border: '1px solid #ccc' }}>{line.id}</td>
                    <td style={{ padding: '4px', border: '1px solid #ccc' }}>{line.project}</td>
                    <td style={{ padding: '4px', border: '1px solid #ccc' }}>{line.leftWidth}/{line.rightWidth}m</td>
                    <td style={{ padding: '4px', border: '1px solid #ccc', fontSize: '10px' }}>{line.createdDate}</td>
                    <td style={{ padding: '4px', border: '1px solid #ccc' }}>
                      <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                        <Button size="sm" onClick={() => this.zoomToLine(line.id)}>Zoom</Button>
                        <Button size="sm" onClick={() => this.showVertices(line.id)}>Vertices</Button>
                        <Button size="sm" onClick={() => this.exportLineGeoJSON(line.id)}>Export</Button>
                        <Button size="sm" type="danger" onClick={() => this.deleteLine(line.id)}>Del</Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Polygons Table */}
        <div style={{ marginBottom: '20px' }}>
          <h4>ROW Polygons ({polygons.length})</h4>
          <div style={{ overflowX: 'auto', maxHeight: '300px', overflowY: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
              <thead>
                <tr style={{ background: '#e0e0e0', position: 'sticky', top: 0 }}>
                  <th style={{ padding: '8px', border: '1px solid #ccc' }}>ID</th>
                  <th style={{ padding: '8px', border: '1px solid #ccc' }}>Line ID</th>
                  <th style={{ padding: '8px', border: '1px solid #ccc' }}>Project</th>
                  <th style={{ padding: '8px', border: '1px solid #ccc' }}>Area (m²)</th>
                  <th style={{ padding: '8px', border: '1px solid #ccc' }}>Perimeter (m)</th>
                  <th style={{ padding: '8px', border: '1px solid #ccc' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {polygons.map(polygon => (
                  <tr key={polygon.id}>
                    <td style={{ padding: '4px', border: '1px solid #ccc' }}>{polygon.id}</td>
                    <td style={{ padding: '4px', border: '1px solid #ccc' }}>{polygon.lineId}</td>
                    <td style={{ padding: '4px', border: '1px solid #ccc' }}>{polygon.project}</td>
                    <td style={{ padding: '4px', border: '1px solid #ccc' }}>{polygon.area.toFixed(2)}</td>
                    <td style={{ padding: '4px', border: '1px solid #ccc' }}>{polygon.perimeter.toFixed(2)}</td>
                    <td style={{ padding: '4px', border: '1px solid #ccc' }}>
                      <div style={{ display: 'flex', gap: '4px' }}>
                        <Button size="sm" onClick={() => this.zoomToPolygon(polygon.id)}>Zoom</Button>
                        <Button size="sm" onClick={() => this.exportPolygonGeoJSON(polygon.id)}>Export</Button>
                        <Button size="sm" type="danger" onClick={() => this.deletePolygon(polygon.id)}>Del</Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Vertices Modal */}
        <Modal isOpen={verticesModalOpen} toggle={() => this.setState({ verticesModalOpen: false })} style={{ maxWidth: '900px' }}>
          <ModalHeader toggle={() => this.setState({ verticesModalOpen: false })}>
            Vertex Analytics
          </ModalHeader>
          <ModalBody>
            <Button onClick={this.exportVertices} style={{ marginBottom: '10px' }}>
              Export to CSV
            </Button>
            <div style={{ overflowX: 'auto', maxHeight: '500px' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
                <thead>
                  <tr style={{ background: '#e0e0e0' }}>
                    <th style={{ padding: '6px', border: '1px solid #ccc' }}>Index</th>
                    <th style={{ padding: '6px', border: '1px solid #ccc' }}>X</th>
                    <th style={{ padding: '6px', border: '1px solid #ccc' }}>Y</th>
                    <th style={{ padding: '6px', border: '1px solid #ccc' }}>Bearing</th>
                    <th style={{ padding: '6px', border: '1px solid #ccc' }}>Bearing DMS</th>
                    <th style={{ padding: '6px', border: '1px solid #ccc' }}>Bend Angle</th>
                    <th style={{ padding: '6px', border: '1px solid #ccc' }}>Direction</th>
                    <th style={{ padding: '6px', border: '1px solid #ccc' }}>Segment (m)</th>
                    <th style={{ padding: '6px', border: '1px solid #ccc' }}>Distance (m)</th>
                  </tr>
                </thead>
                <tbody>
                  {currentVertices.map(v => (
                    <tr key={v.index}>
                      <td style={{ padding: '4px', border: '1px solid #ccc' }}>{v.index}</td>
                      <td style={{ padding: '4px', border: '1px solid #ccc' }}>{v.x.toFixed(6)}</td>
                      <td style={{ padding: '4px', border: '1px solid #ccc' }}>{v.y.toFixed(6)}</td>
                      <td style={{ padding: '4px', border: '1px solid #ccc' }}>{v.bearing.toFixed(2)}°</td>
                      <td style={{ padding: '4px', border: '1px solid #ccc' }}>{v.bearingDMS}</td>
                      <td style={{ padding: '4px', border: '1px solid #ccc' }}>{v.bendAngle.toFixed(2)}°</td>
                      <td style={{ padding: '4px', border: '1px solid #ccc' }}>{v.bendDirection}</td>
                      <td style={{ padding: '4px', border: '1px solid #ccc' }}>{v.segmentLength.toFixed(2)}</td>
                      <td style={{ padding: '4px', border: '1px solid #ccc' }}>{v.distanceFromStart.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </ModalBody>
        </Modal>
      </div>
    );
  }
}
