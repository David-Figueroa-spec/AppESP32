import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  StyleSheet, Text, View, TouchableOpacity, ScrollView,
  SafeAreaView, ActivityIndicator, Switch, Share, Platform,
  Vibration, Alert,
} from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { LineChart } from 'react-native-gifted-charts';

// ══════════════════════════════════════════════════════════════════════
//  CONFIGURACIÓN
// ══════════════════════════════════════════════════════════════════════
const SUPABASE_URL  = 'https://xezrsaxatclqoadymalm.supabase.co';
const SUPABASE_ANON = 'sb_publishable_MqtmstW_6bMGlM6-q7-a_Q_-L6VYWyU';
const ESP32_IP      = 'http://192.168.1.50/api/datos';

const ALERTAS = {
  dht_temp:  { min: 10, max: 35, label: 'Temp DHT' },
  dht_hum:   { min: 20, max: 85, label: 'Humedad' },
  lm35_temp: { min: 10, max: 35, label: 'Temp LM35' },
};

// ══════════════════════════════════════════════════════════════════════
//  SUPABASE (fetch directo, sin librería)
// ══════════════════════════════════════════════════════════════════════
const sbHeaders = {
  'Content-Type': 'application/json',
  'apikey': SUPABASE_ANON,
  'Authorization': `Bearer ${SUPABASE_ANON}`,
};

async function sbSelect(tabla, opciones = '') {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${tabla}?${opciones}`, {
    headers: { ...sbHeaders, 'Prefer': 'return=representation' },
  });
  if (!res.ok) throw new Error(`Supabase SELECT error: ${res.status}`);
  return res.json();
}

async function sbInsert(tabla, datos) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${tabla}`, {
    method: 'POST',
    headers: { ...sbHeaders, 'Prefer': 'return=minimal' },
    body: JSON.stringify(datos),
  });
  if (!res.ok) throw new Error(`Supabase INSERT error: ${res.status}`);
}

// ══════════════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════════════
function validarLectura({ dht_temp, dht_hum, lm35_temp }) {
  if (dht_temp  < 0 || dht_temp  > 60)  return false;
  if (dht_hum   < 0 || dht_hum   > 100) return false;
  if (lm35_temp < 0 || lm35_temp > 60)  return false;
  return true;
}

function formatHora(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
}

function formatFecha(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('es-CO', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function verificarAlertas(datos) {
  const alertas = [];
  Object.entries(ALERTAS).forEach(([key, cfg]) => {
    const val = datos[key];
    if (val < cfg.min) alertas.push(`⬇️ ${cfg.label} muy baja: ${val.toFixed(1)}`);
    if (val > cfg.max) alertas.push(`⬆️ ${cfg.label} muy alta: ${val.toFixed(1)}`);
  });
  return alertas;
}

function generarCSV(historial) {
  const header = 'Fecha,Temp DHT (°C),Humedad (%),Temp LM35 (°C)\n';
  const filas = historial.map(r =>
    `${formatFecha(r.timestamp)},${r.dht_temp?.toFixed(2)},${r.dht_hum?.toFixed(2)},${r.lm35_temp?.toFixed(2)}`
  ).join('\n');
  return header + filas;
}

// ══════════════════════════════════════════════════════════════════════
//  PANTALLA PRINCIPAL
// ══════════════════════════════════════════════════════════════════════
function PantallaMonitoreo() {
  const [lectura, setLectura]                     = useState(null);
  const [historial, setHistorial]                 = useState([]);
  const [cargando, setCargando]                   = useState(false);
  const [cargandoHistorial, setCargandoHistorial] = useState(false);
  const [error, setError]                         = useState(null);
  const [alertas, setAlertas]                     = useState([]);
  const [autoSync, setAutoSync]                   = useState(false);
  const [conectado, setConectado]                 = useState(null);
  const [ultimaVez, setUltimaVez]                 = useState(null);
  const [sensorActivo, setSensorActivo]           = useState('dht_temp');
  const intervaloRef                              = useRef(null);

  const cargarHistorial = useCallback(async () => {
    setCargandoHistorial(true);
    try {
      const data = await sbSelect(
        'lectura',
        'select=dht_temp,dht_hum,lm35_temp,timestamp&order=timestamp.desc&limit=30'
      );
      setHistorial(data.reverse());
    } catch (e) {
      console.warn('Error historial:', e.message);
    } finally {
      setCargandoHistorial(false);
    }
  }, []);

  const guardarEnSupabase = async (datos) => {
    try {
      await sbInsert('lectura', {
        dht_temp: datos.dht_temp,
        dht_hum: datos.dht_hum,
        lm35_temp: datos.lm35_temp,
      });
      cargarHistorial();
    } catch (e) {
      console.warn('Error guardando:', e.message);
    }
  };

  const sincronizar = useCallback(async () => {
    if (cargando) return;
    setCargando(true);
    setError(null);
    try {
      const response = await fetch(ESP32_IP, { signal: AbortSignal.timeout(5000) });
      const json = await response.json();

      if (!json.ok) { setError('ESP32: error en sensores'); setConectado(false); return; }

      const datos = {
        dht_temp:  parseFloat(json.dht_temp),
        dht_hum:   parseFloat(json.dht_hum),
        lm35_temp: parseFloat(json.lm35_temp),
      };

      if (!validarLectura(datos)) { setError('Datos fuera de rango'); return; }

      setLectura(datos);
      setConectado(true);
      setUltimaVez(new Date());

      const nuevasAlertas = verificarAlertas(datos);
      if (nuevasAlertas.length > 0) {
        setAlertas(nuevasAlertas);
        Vibration.vibrate(400);
        Alert.alert('⚠️ Alerta de sensores', nuevasAlertas.join('\n'));
      } else {
        setAlertas([]);
      }

      await guardarEnSupabase(datos);
    } catch (e) {
      setConectado(false);
      const sim = {
        dht_temp:  parseFloat((Math.random() * 15 + 20).toFixed(2)),
        dht_hum:   parseFloat((Math.random() * 40 + 40).toFixed(2)),
        lm35_temp: parseFloat((Math.random() * 15 + 18).toFixed(2)),
      };
      setLectura(sim);
      setError('⚠️ Sin conexión al ESP32 — datos simulados');
    } finally {
      setCargando(false);
    }
  }, [cargando]);

  // Auto-sincronización
  useEffect(() => {
    if (autoSync) {
      sincronizar();
      intervaloRef.current = setInterval(sincronizar, 10000);
    } else {
      clearInterval(intervaloRef.current);
    }
    return () => clearInterval(intervaloRef.current);
  }, [autoSync]);

  useEffect(() => { cargarHistorial(); }, [cargarHistorial]);

  const exportarCSV = async () => {
    if (historial.length === 0) { Alert.alert('Sin datos', 'Sincroniza primero para tener datos.'); return; }
    const csv = generarCSV(historial);
    await Share.share({ message: csv, title: 'Datos ESP32' });
  };

  const datosGrafico = historial.map((r, i) => ({
    value: parseFloat(r[sensorActivo]?.toFixed(2) ?? 0),
    label: i % 6 === 0 ? formatHora(r.timestamp) : '',
  }));

  const coloresSensor = {
    dht_temp:  '#E8593C',
    dht_hum:   '#3B8BD4',
    lm35_temp: '#1D9E75',
  };

  const colorActivo = coloresSensor[sensorActivo];

  return (
    <SafeAreaView style={s.container}>
      <ScrollView contentContainerStyle={s.scroll}>

        {/* Header con estado de conexión */}
        <View style={s.header}>
          <View>
            <Text style={s.titulo}>Monitor ESP32</Text>
            <Text style={s.subtitulo}>
              {conectado === null ? 'Sin sincronizar' :
               conectado ? `Conectado · ${ultimaVez ? formatHora(ultimaVez.toISOString()) : ''}` :
               'Sin conexión · modo simulación'}
            </Text>
          </View>
          <View style={[s.estadoBadge, {
            backgroundColor: conectado === null ? '#f0f0f0' : conectado ? '#e8f5e9' : '#fff3e0'
          }]}>
            <View style={[s.estadoPunto, {
              backgroundColor: conectado === null ? '#aaa' : conectado ? '#4CAF50' : '#FF9800'
            }]} />
            <Text style={[s.estadoTexto, {
              color: conectado === null ? '#aaa' : conectado ? '#2E7D32' : '#E65100'
            }]}>
              {conectado === null ? 'Offline' : conectado ? 'Online' : 'Simulando'}
            </Text>
          </View>
        </View>

        {/* Tarjetas de sensores */}
        <View style={s.fila}>
          {[
            { key: 'dht_temp',  label: 'TEMP DHT',  unidad: '°C', color: '#E8593C', icon: '🌡' },
            { key: 'dht_hum',   label: 'HUMEDAD',   unidad: '%',  color: '#3B8BD4', icon: '💧' },
            { key: 'lm35_temp', label: 'TEMP LM35', unidad: '°C', color: '#1D9E75', icon: '🌡' },
          ].map(({ key, label, unidad, color, icon }) => (
            <TouchableOpacity
              key={key}
              style={[s.tarjeta, sensorActivo === key && { borderColor: color, borderWidth: 2 }]}
              onPress={() => setSensorActivo(key)}
            >
              <Text style={s.tarjetaIcon}>{icon}</Text>
              <Text style={s.tarjetaLabel}>{label}</Text>
              <Text style={[s.tarjetaValor, { color }]}>
                {lectura ? `${lectura[key].toFixed(1)}${unidad}` : '—'}
              </Text>
              {lectura && (lectura[key] < ALERTAS[key].min || lectura[key] > ALERTAS[key].max) && (
                <Text style={s.alertIcon}>⚠️</Text>
              )}
            </TouchableOpacity>
          ))}
        </View>

        {/* Alertas */}
        {alertas.length > 0 && (
          <View style={s.alertaBox}>
            {alertas.map((a, i) => <Text key={i} style={s.alertaTexto}>{a}</Text>)}
          </View>
        )}

        {/* Error */}
        {error && (
          <View style={s.errorBox}>
            <Text style={s.errorTexto}>{error}</Text>
          </View>
        )}

        {/* Gráfico */}
        <View style={s.chartCard}>
          <View style={s.chartHeader}>
            <Text style={s.chartTitulo}>
              {{ dht_temp: 'Temp DHT (°C)', dht_hum: 'Humedad (%)', lm35_temp: 'Temp LM35 (°C)' }[sensorActivo]}
            </Text>
            <TouchableOpacity onPress={cargarHistorial}>
              <Text style={[s.linkBtn, { color: colorActivo }]}>
                {cargandoHistorial ? 'Cargando...' : '↻ Refrescar'}
              </Text>
            </TouchableOpacity>
          </View>
          {datosGrafico.length > 1 ? (
            <LineChart
              data={datosGrafico}
              color={colorActivo}
              thickness={2.5}
              dataPointsColor={colorActivo}
              radius={4}
              spacing={28}
              hideRules={false}
              rulesColor="#f0f0f0"
              yAxisColor="#eee"
              xAxisColor="#eee"
              yAxisTextStyle={{ color: '#bbb', fontSize: 10 }}
              xAxisLabelTextStyle={{ color: '#bbb', fontSize: 9 }}
              curved
            />
          ) : (
            <Text style={s.sinDatos}>
              {cargandoHistorial ? 'Cargando...' : 'Sin datos — sincroniza para empezar'}
            </Text>
          )}
          <Text style={s.chartNota}>Toca una tarjeta para cambiar el sensor graficado</Text>
        </View>

        {/* Tabla historial */}
        {historial.length > 0 && (
          <View style={s.tablaCard}>
            <View style={s.chartHeader}>
              <Text style={s.chartTitulo}>Últimas lecturas</Text>
              <TouchableOpacity onPress={exportarCSV}>
                <Text style={s.linkBtn}>⬇ Exportar CSV</Text>
              </TouchableOpacity>
            </View>
            <View style={s.tablaHeader}>
              {['Hora', 'DHT °C', 'Hum %', 'LM35 °C'].map(h => (
                <Text key={h} style={[s.celda, s.celdaHeader]}>{h}</Text>
              ))}
            </View>
            {historial.slice(-8).reverse().map((r, i) => (
              <View key={i} style={[s.tablaFila, i % 2 === 0 && s.filaImpar]}>
                <Text style={s.celda}>{formatHora(r.timestamp)}</Text>
                <Text style={[s.celda, { color: '#E8593C' }]}>{r.dht_temp?.toFixed(1)}</Text>
                <Text style={[s.celda, { color: '#3B8BD4' }]}>{r.dht_hum?.toFixed(1)}</Text>
                <Text style={[s.celda, { color: '#1D9E75' }]}>{r.lm35_temp?.toFixed(1)}</Text>
              </View>
            ))}
          </View>
        )}

        {/* Controles */}
        <View style={s.controlesCard}>
          <View style={s.controlFila}>
            <View>
              <Text style={s.controlLabel}>Auto-sincronización</Text>
              <Text style={s.controlSub}>Actualiza cada 10 segundos</Text>
            </View>
            <Switch
              value={autoSync}
              onValueChange={setAutoSync}
              trackColor={{ false: '#ddd', true: '#007AFF' }}
              thumbColor="#fff"
            />
          </View>
        </View>

        {/* Botón sincronizar */}
        <TouchableOpacity
          style={[s.boton, cargando && s.botonOff]}
          onPress={sincronizar}
          disabled={cargando}
        >
          {cargando
            ? <ActivityIndicator color="#fff" />
            : <Text style={s.botonTexto}>
                {autoSync ? '⟳ Auto-sync activo' : 'Sincronizar con ESP32'}
              </Text>
          }
        </TouchableOpacity>

      </ScrollView>
    </SafeAreaView>
  );
}

// ══════════════════════════════════════════════════════════════════════
//  PANTALLA PROYECTO FUTURO
// ══════════════════════════════════════════════════════════════════════
function PantallaProyecto() {
  return (
    <SafeAreaView style={s.container}>
      <ScrollView contentContainerStyle={[s.scroll, { justifyContent: 'center', flex: 1 }]}>
        <View style={s.futuroCard}>
          <Text style={s.futuroIcon}>🚀</Text>
          <Text style={s.futuroTitulo}>Próximo proyecto</Text>
          <Text style={s.futuroSub}>Este espacio está reservado para una futura expansión del sistema.</Text>
          <View style={s.futuroBadge}>
            <Text style={s.futuroBadgeTexto}>En desarrollo</Text>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

// ══════════════════════════════════════════════════════════════════════
//  NAVEGACIÓN
// ══════════════════════════════════════════════════════════════════════
const Tab = createBottomTabNavigator();

export default function App() {
  return (
    <NavigationContainer>
      <Tab.Navigator
        screenOptions={({ route }) => ({
          headerShown: false,
          tabBarStyle: s.tabBar,
          tabBarActiveTintColor: '#007AFF',
          tabBarInactiveTintColor: '#aaa',
          tabBarLabelStyle: { fontSize: 12, fontWeight: '500' },
          tabBarIcon: ({ focused, color }) => {
            const icons = { Monitor: '📡', Proyecto: '🚀' };
            return (
              <Text style={{ fontSize: 20, opacity: focused ? 1 : 0.5 }}>
                {icons[route.name]}
              </Text>
            );
          },
        })}
      >
        <Tab.Screen name="Monitor"   component={PantallaMonitoreo} />
        <Tab.Screen name="Proyecto"  component={PantallaProyecto}  />
      </Tab.Navigator>
    </NavigationContainer>
  );
}

// ══════════════════════════════════════════════════════════════════════
//  ESTILOS
// ══════════════════════════════════════════════════════════════════════
const s = StyleSheet.create({
  container:      { flex: 1, backgroundColor: '#000000' },
  scroll:         { padding: 16, paddingBottom: 40 },

  header:         { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, marginTop: 8 },
  titulo:         { fontSize: 22, fontWeight: 'bold', color: '#1a1a1a' },
  subtitulo:      { fontSize: 12, color: '#999', marginTop: 2 },
  estadoBadge:    { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 20, gap: 6 },
  estadoPunto:    { width: 8, height: 8, borderRadius: 4 },
  estadoTexto:    { fontSize: 12, fontWeight: '600' },

  fila:           { flexDirection: 'row', gap: 8, marginBottom: 14 },
  tarjeta:        { flex: 1, backgroundColor: '#fff', borderRadius: 14, padding: 12, alignItems: 'center',
                    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 6, elevation: 3,
                    borderWidth: 0, borderColor: 'transparent' },
  tarjetaIcon:    { fontSize: 18, marginBottom: 4 },
  tarjetaLabel:   { fontSize: 9, fontWeight: '700', color: '#bbb', letterSpacing: 0.8, marginBottom: 4 },
  tarjetaValor:   { fontSize: 18, fontWeight: 'bold' },
  alertIcon:      { fontSize: 12, marginTop: 2 },

  alertaBox:      { backgroundColor: '#fff8e1', borderRadius: 10, padding: 12, marginBottom: 10, borderLeftWidth: 3, borderLeftColor: '#FF9800' },
  alertaTexto:    { color: '#E65100', fontSize: 13, marginBottom: 2 },
  errorBox:       { backgroundColor: '#fff3f3', borderRadius: 10, padding: 12, marginBottom: 10, borderLeftWidth: 3, borderLeftColor: '#E8593C' },
  errorTexto:     { color: '#c0392b', fontSize: 13 },

  chartCard:      { backgroundColor: '#fff', borderRadius: 16, padding: 16, marginBottom: 14,
                    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 6, elevation: 3 },
  chartHeader:    { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  chartTitulo:    { fontSize: 15, fontWeight: '600', color: '#333' },
  linkBtn:        { fontSize: 13, color: '#007AFF' },
  sinDatos:       { color: '#ccc', fontSize: 13, textAlign: 'center', paddingVertical: 30 },
  chartNota:      { fontSize: 11, color: '#ccc', textAlign: 'center', marginTop: 8 },

  tablaCard:      { backgroundColor: '#fff', borderRadius: 16, padding: 16, marginBottom: 14,
                    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 6, elevation: 3 },
  tablaHeader:    { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#f0f0f0', paddingBottom: 6, marginBottom: 4, marginTop: 10 },
  tablaFila:      { flexDirection: 'row', paddingVertical: 5 },
  filaImpar:      { backgroundColor: '#fafafa' },
  celda:          { flex: 1, fontSize: 12, color: '#555', textAlign: 'center' },
  celdaHeader:    { fontWeight: '700', color: '#bbb', fontSize: 11 },

  controlesCard:  { backgroundColor: '#fff', borderRadius: 16, padding: 16, marginBottom: 14,
                    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 6, elevation: 3 },
  controlFila:    { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  controlLabel:   { fontSize: 15, fontWeight: '600', color: '#333' },
  controlSub:     { fontSize: 12, color: '#aaa', marginTop: 2 },

  boton:          { height: 54, backgroundColor: '#007AFF', borderRadius: 14,
                    justifyContent: 'center', alignItems: 'center',
                    shadowColor: '#007AFF', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.25, shadowRadius: 8, elevation: 5 },
  botonOff:       { backgroundColor: '#a0c7ff' },
  botonTexto:     { color: '#fff', fontSize: 16, fontWeight: 'bold' },

  tabBar:         { backgroundColor: '#fff', borderTopColor: '#f0f0f0', borderTopWidth: 0.5, height: 60, paddingBottom: 8 },

  futuroCard:     { backgroundColor: '#fff', borderRadius: 20, padding: 40, alignItems: 'center', marginTop: 60,
                    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 10, elevation: 3 },
  futuroIcon:     { fontSize: 48, marginBottom: 16 },
  futuroTitulo:   { fontSize: 22, fontWeight: 'bold', color: '#1a1a1a', marginBottom: 10 },
  futuroSub:      { fontSize: 14, color: '#999', textAlign: 'center', lineHeight: 22, marginBottom: 20 },
  futuroBadge:    { backgroundColor: '#e8f4fd', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20 },
  futuroBadgeTexto: { color: '#007AFF', fontWeight: '600', fontSize: 13 },
});