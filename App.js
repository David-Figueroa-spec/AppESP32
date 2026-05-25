import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  StyleSheet, Text, View, TouchableOpacity, ScrollView,
  SafeAreaView, ActivityIndicator, Switch, Share, Platform,
  Vibration, Alert, TextInput,  // ← agrega TextInput aquí
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
//  PANTALLA PROYECTO FUTURO — Sensor de Luz (Lux → PPFD → DLI)
// ══════════════════════════════════════════════════════════════════════
import { LightSensor } from 'expo-sensors';
import {
  Modal,
  Pressable,
} from 'react-native';

// ── Componente Modal Educativo ─────────────────────────────────────────
function ModalComoFunciona({ visible, onClose, styles: s }) {
  const conceptos = [
    {
      icono: '💡',
      titulo: 'Lux — la cantidad de luz que llega',
      tag: 'Lo que mide el sensor del celular',
      tagColor: '#FEF3C7',
      tagTexto: '#92400E',
      cuerpo:
        'El lux mide cuánta luz visible recibe una superficie. Un cuarto oscuro tiene ~50 lux, una oficina ~500 lux y el sol directo puede superar los 100 000 lux. El sensor del celular (el mismo que ajusta el brillo de pantalla) capta esta intensidad.',
      analogia:
        '💬 Piénsalo como el caudal de una manguera: los lux dicen cuánta agua sale, pero no si esa agua sirve para tu planta.',
      analogiaColor: '#FFF8E1',
      analogiaBorde: '#F59E0B',
    },
    {
      icono: '⚡',
      titulo: 'PPFD — la luz que las plantas realmente aprovechan',
      tag: 'Calculado desde los lux',
      tagColor: '#D1FAE5',
      tagTexto: '#065F46',
      cuerpo:
        'Las plantas solo absorben ciertas longitudes de onda (rojo y azul principalmente) para la fotosíntesis. El PPFD mide esos fotones útiles en µmol/m²/s. Por eso se usa un factor Kₛ según el tipo de lámpara: el LED, el sol y el fluorescente emiten espectros distintos.',
      analogia:
        '💬 Es como filtrar el agua: el PPFD solo cuenta las gotas que la planta puede "beber" para crecer.',
      analogiaColor: '#E8F5E9',
      analogiaBorde: '#1D9E75',
    },
    {
      icono: '📅',
      titulo: 'DLI — la dosis diaria de luz',
      tag: 'El dato más útil para el cultivo',
      tagColor: '#EDE9FE',
      tagTexto: '#4C1D95',
      cuerpo:
        'El DLI (Daily Light Integral) acumula todo el PPFD recibido durante el día. Si el PPFD es la velocidad, el DLI es la distancia total. Se mide en mol/m²/día. Un tomate necesita más "dosis" que una orquídea, igual que una persona activa necesita más calorías.',
      analogia:
        '💬 Menos de 5 = muy bajo · 5–15 = moderado · 15–30 = óptimo para cultivo · +30 = alto',
      analogiaColor: '#F3E8FF',
      analogiaBorde: '#7C3AED',
    },
  ];

  const plantas = [
    { nombre: 'Suculentas / cactus',  rango: '20–30',  color: '#E24B4A' },
    { nombre: 'Tomates / pimientos',  rango: '22–30',  color: '#F59E0B' },
    { nombre: 'Lechuga / espinaca',   rango: '12–17',  color: '#22C55E' },
    { nombre: 'Albahaca / hierbas',   rango: '12–20',  color: '#1D9E75' },
    { nombre: 'Orquídeas',            rango: '6–12',   color: '#7C3AED' },
    { nombre: 'Plantas de interior',  rango: '4–8',    color: '#378ADD' },
  ];

  const pasos = [
    'Coloca el celular donde está la planta, con la cámara apuntando hacia la fuente de luz.',
    'Toca "Medir Lux ahora". La app promedia 5 lecturas seguidas para mayor precisión.',
    'Elige el tipo de lámpara: solar, LED, fluorescente, HPS o Metal Halide.',
    'Indica cuántas horas al día está encendida la luz (o sale el sol).',
    'Lee el DLI y compáralo con el rango ideal de tu planta en la tabla.',
  ];

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView style={{ flex: 1, backgroundColor: '#F5F5F5' }}>
        {/* Header del modal */}
        <View style={m.modalHeader}>
          <View>
            <Text style={m.modalTitulo}>¿Cómo funciona?</Text>
            <Text style={m.modalSubtitulo}>Guía de mediciones · Lux → PPFD → DLI</Text>
          </View>
          <TouchableOpacity onPress={onClose} style={m.cerrarBtn}>
            <Text style={m.cerrarTexto}>✕ Cerrar</Text>
          </TouchableOpacity>
        </View>

        <ScrollView
          contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
          showsVerticalScrollIndicator={false}
        >

          {/* ── Sección: Qué mide cada valor ── */}
          <Text style={m.seccion}>📊 Qué significa cada valor</Text>

          {conceptos.map((c, i) => (
            <View key={i} style={m.card}>
              <View style={m.cardHeaderRow}>
                <Text style={{ fontSize: 28 }}>{c.icono}</Text>
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={m.cardTitulo}>{c.titulo}</Text>
                  <View style={[m.tag, { backgroundColor: c.tagColor }]}>
                    <Text style={[m.tagTexto, { color: c.tagTexto }]}>{c.tag}</Text>
                  </View>
                </View>
              </View>
              <Text style={m.cardCuerpo}>{c.cuerpo}</Text>
              <View style={[m.analogia, { backgroundColor: c.analogiaColor, borderLeftColor: c.analogiaBorde }]}>
                <Text style={m.analogiaTexto}>{c.analogia}</Text>
              </View>
            </View>
          ))}

          {/* ── Sección: Flujo de cálculo ── */}
          <Text style={[m.seccion, { marginTop: 8 }]}>🔢 Cómo se calcula</Text>
          <View style={m.card}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                {[
                  { val: 'Lux',        sub: 'sensor',        color: '#F59E0B' },
                  { val: '× Kₛ',       sub: 'tipo lámpara',  color: '#1D9E75' },
                  { val: '= PPFD',     sub: 'µmol/m²/s',     color: '#378ADD' },
                  { val: '× h × 0.0036', sub: 'horas luz',   color: '#7C3AED' },
                  { val: '= DLI',      sub: 'mol/m²/día',    color: '#1D9E75' },
                ].map((paso, i) => (
                  <View key={i} style={[m.pasoBox, { borderTopColor: paso.color }]}>
                    <Text style={[m.pasoVal, { color: paso.color }]}>{paso.val}</Text>
                    <Text style={m.pasoSub}>{paso.sub}</Text>
                  </View>
                ))}
              </View>
            </ScrollView>
            <View style={[m.analogia, { backgroundColor: '#E8F5E9', borderLeftColor: '#1D9E75', marginTop: 12 }]}>
              <Text style={m.analogiaTexto}>
                Kₛ varía según el espectro de cada fuente (Apogee Instruments). El factor 0.0036 convierte segundos a horas y µmol a mol.
              </Text>
            </View>
          </View>

          {/* ── Sección: Referencia por planta ── */}
          <Text style={[m.seccion, { marginTop: 8 }]}>🌿 DLI de referencia por cultivo</Text>
          <View style={m.card}>
            {plantas.map((p, i) => (
              <View key={i} style={[m.plantaFila, i < plantas.length - 1 && m.plantaFilaBorde]}>
                <View style={[m.plantaDot, { backgroundColor: p.color }]} />
                <Text style={m.plantaNombre}>{p.nombre}</Text>
                <Text style={[m.plantaRango, { color: p.color }]}>{p.rango} mol/m²/día</Text>
              </View>
            ))}
          </View>

          {/* ── Sección: Cómo medir ── */}
          <Text style={[m.seccion, { marginTop: 8 }]}>📱 Cómo hacer la medición</Text>
          <View style={m.card}>
            {pasos.map((paso, i) => (
              <View key={i} style={[m.pasoFila, i < pasos.length - 1 && { marginBottom: 14 }]}>
                <View style={m.pasoNumCirculo}>
                  <Text style={m.pasoNum}>{i + 1}</Text>
                </View>
                <Text style={m.pasoTexto}>{paso}</Text>
              </View>
            ))}
          </View>

          {/* ── Consejo final ── */}
          <View style={[m.card, { backgroundColor: '#E8F4FD', borderLeftWidth: 4, borderLeftColor: '#378ADD' }]}>
            <Text style={[m.cardTitulo, { color: '#1a5276', marginBottom: 6 }]}>
              💡 ¿Qué hago con el resultado?
            </Text>
            <Text style={[m.cardCuerpo, { color: '#1a5276' }]}>
              <Text style={{ fontWeight: '700' }}>DLI muy bajo:</Text> acerca la lámpara, aumenta las horas de luz o cambia a una fuente más potente.{'\n\n'}
              <Text style={{ fontWeight: '700' }}>DLI muy alto:</Text> aleja la fuente o usa una malla de sombreo para evitar quemaduras en las hojas.{'\n\n'}
              <Text style={{ fontWeight: '700' }}>Precisión:</Text> el sensor del celular es aproximado. Para resultados profesionales, calibra con un luxómetro de referencia.
            </Text>
          </View>

        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

// ── Estilos del Modal ─────────────────────────────────────────────────
const m = StyleSheet.create({
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#E8E8E8',
  },
  modalTitulo:    { fontSize: 18, fontWeight: '700', color: '#1A1A1A' },
  modalSubtitulo: { fontSize: 13, color: '#888', marginTop: 2 },
  cerrarBtn:      { backgroundColor: '#F0F0F0', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20 },
  cerrarTexto:    { fontSize: 14, color: '#555', fontWeight: '600' },

  seccion:        { fontSize: 13, fontWeight: '700', color: '#555', marginBottom: 10, marginTop: 4, textTransform: 'uppercase', letterSpacing: 0.5 },

  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  cardHeaderRow:  { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 10 },
  cardTitulo:     { fontSize: 15, fontWeight: '700', color: '#1A1A1A', lineHeight: 20 },
  tag:            { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 20, marginTop: 4 },
  tagTexto:       { fontSize: 11, fontWeight: '600' },
  cardCuerpo:     { fontSize: 14, color: '#444', lineHeight: 22 },
  analogia: {
    borderLeftWidth: 3,
    borderRadius: 4,
    padding: 10,
    marginTop: 10,
  },
  analogiaTexto:  { fontSize: 13, color: '#555', lineHeight: 20 },

  pasoBox: {
    borderTopWidth: 3,
    paddingTop: 8,
    paddingHorizontal: 12,
    paddingBottom: 10,
    backgroundColor: '#F9F9F9',
    borderRadius: 8,
    alignItems: 'center',
    minWidth: 90,
  },
  pasoVal:        { fontSize: 15, fontWeight: '700' },
  pasoSub:        { fontSize: 11, color: '#888', marginTop: 2 },

  plantaFila:     { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  plantaFilaBorde:{ borderBottomWidth: 1, borderBottomColor: '#F0F0F0' },
  plantaDot:      { width: 10, height: 10, borderRadius: 5, marginRight: 10 },
  plantaNombre:   { flex: 1, fontSize: 14, color: '#333' },
  plantaRango:    { fontSize: 13, fontWeight: '600' },

  pasoFila:       { flexDirection: 'row', alignItems: 'flex-start' },
  pasoNumCirculo: { width: 26, height: 26, borderRadius: 13, backgroundColor: '#1D9E75', alignItems: 'center', justifyContent: 'center', marginRight: 12, marginTop: 1, flexShrink: 0 },
  pasoNum:        { color: '#fff', fontSize: 13, fontWeight: '700' },
  pasoTexto:      { flex: 1, fontSize: 14, color: '#444', lineHeight: 22 },
});


// ══════════════════════════════════════════════════════════════════════
//  PANTALLA PRINCIPAL
// ══════════════════════════════════════════════════════════════════════
function PantallaProyecto() {
  const [lux, setLux]               = useState(null);
  const [midiendo, setMidiendo]     = useState(false);
  const [horasInput, setHorasInput] = useState('12');
  const [tipoLuz, setTipoLuz]       = useState(0);
  const [error, setError]           = useState(null);
  const [modalVisible, setModalVisible] = useState(false); // ← nuevo
  const suscripcionRef              = useRef(null);
  const muestrasRef                 = useRef([]);

  const fuentes = [
    { label: '☀️ Solar',        ks: 0.0185 },
    { label: '💡 Fluorescente', ks: 0.0135 },
    { label: '🟠 HPS',          ks: 0.0122 },
    { label: '⚡ Metal Halide', ks: 0.0141 },
    { label: '🔵 LED Blanco',   ks: 0.0154 },
  ];

  const horas = parseFloat(horasInput) || 0;
  const ks    = fuentes[tipoLuz].ks;
  const ppfd  = lux ? lux * ks : 0;
  const dli   = ppfd * horas * 0.0036;

  const getColorDLI = (d) => {
    if (d < 5)  return '#E8593C';
    if (d < 15) return '#FF9800';
    if (d < 30) return '#4CAF50';
    return '#1D9E75';
  };

  const detenerMedicion = () => {
    if (suscripcionRef.current) {
      suscripcionRef.current.remove();
      suscripcionRef.current = null;
    }
    setMidiendo(false);
  };

  const iniciarMedicion = async () => {
    setError(null);

    const disponible = await LightSensor.isAvailableAsync();
    if (!disponible) {
      setError('❌ Este dispositivo no tiene sensor de luz ambiental');
      return;
    }

    const { status } = await LightSensor.requestPermissionsAsync();
    if (status !== 'granted') {
      setError('❌ Permiso denegado — actívalo en Configuración > Apps > Permisos');
      return;
    }

    setMidiendo(true);
    muestrasRef.current = [];

    try {
      suscripcionRef.current = LightSensor.addListener(({ illuminance }) => {
        muestrasRef.current.push(illuminance);
        if (muestrasRef.current.length >= 5) {
          const promedio = muestrasRef.current.reduce((a, b) => a + b, 0) / muestrasRef.current.length;
          setLux(parseFloat(promedio.toFixed(1)));
          detenerMedicion();
        }
      });
    } catch (e) {
      setError(`❌ Error al iniciar sensor: ${e.message}`);
      detenerMedicion();
    }
  };

  useEffect(() => () => detenerMedicion(), []);

  return (
    <SafeAreaView style={s.container}>

      {/* ── Modal educativo ── */}
      <ModalComoFunciona
        visible={modalVisible}
        onClose={() => setModalVisible(false)}
        styles={s}
      />

      <ScrollView contentContainerStyle={s.scroll}>

        {/* Header */}
        <View style={s.header}>
          <View>
            <Text style={s.titulo}>Sensor de Luz</Text>
            <Text style={s.subtitulo}>Lux → PPFD → DLI desde el celular</Text>
          </View>
          <View style={[s.estadoBadge, { backgroundColor: '#e8f5e9' }]}>
            <Text style={{ fontSize: 16 }}>🌿</Text>
            <Text style={[s.estadoTexto, { color: '#2E7D32' }]}>Beta</Text>
          </View>
        </View>

        {/* ── BOTÓN "¿Cómo funciona?" ── */}
        <TouchableOpacity
          style={proy.botonGuia}
          onPress={() => setModalVisible(true)}
          activeOpacity={0.75}
        >
          <Text style={proy.botonGuiaIcono}>📖</Text>
          <View style={{ flex: 1 }}>
            <Text style={proy.botonGuiaTitulo}>¿Cómo funciona?</Text>
            <Text style={proy.botonGuiaSub}>Qué son Lux, PPFD y DLI · Guía paso a paso</Text>
          </View>
          <Text style={proy.botonGuiaChevron}>›</Text>
        </TouchableOpacity>

        {/* Botón de medición */}
        <TouchableOpacity
          style={[s.boton, midiendo && s.botonOff, { marginBottom: 14 }]}
          onPress={midiendo ? detenerMedicion : iniciarMedicion}
        >
          {midiendo
            ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <ActivityIndicator color="#fff" />
                <Text style={s.botonTexto}>Midiendo... toca para cancelar</Text>
              </View>
            )
            : (
              <Text style={s.botonTexto}>
                {lux !== null ? `☀️ Volver a medir  (${lux} lux)` : '☀️ Medir Lux ahora'}
              </Text>
            )
          }
        </TouchableOpacity>

        {/* Resultado de lux */}
        {lux !== null && (
          <View style={[s.chartCard, { alignItems: 'center', marginBottom: 14 }]}>
            <Text style={[s.tarjetaLabel, { marginBottom: 4 }]}>LUX MEDIDOS</Text>
            <Text style={[s.tarjetaValor, { fontSize: 40, color: '#FF9800' }]}>{lux}</Text>
            <Text style={proy.unidadChica}>lux · promedio de 5 muestras</Text>
          </View>
        )}

        {/* Error sensor */}
        {error && (
          <View style={s.errorBox}>
            <Text style={s.errorTexto}>{error}</Text>
          </View>
        )}

        {/* Selector tipo de luz */}
        <View style={s.chartCard}>
          <Text style={s.chartTitulo}>Tipo de fuente de luz</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 10 }}>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {fuentes.map((f, i) => (
                <TouchableOpacity
                  key={i}
                  onPress={() => setTipoLuz(i)}
                  style={[proy.chip, tipoLuz === i && proy.chipActivo]}
                >
                  <Text style={[proy.chipTexto, tipoLuz === i && proy.chipTextoActivo]}>
                    {f.label}
                  </Text>
                  <Text style={[proy.chipSub, tipoLuz === i && { color: '#fff' }]}>
                    Kₛ = {f.ks}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </ScrollView>
        </View>

        {/* Horas de luz */}
        <View style={[s.chartCard, { marginBottom: 14 }]}>
          <Text style={s.chartTitulo}>Horas de luz por día</Text>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            {[6, 8, 10, 12, 14, 16, 18].map(h => (
              <TouchableOpacity
                key={h}
                onPress={() => setHorasInput(String(h))}
                style={[proy.chip, String(h) === horasInput && proy.chipActivo]}
              >
                <Text style={[proy.chipTexto, String(h) === horasInput && proy.chipTextoActivo]}>
                  {h}h
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Tarjetas resultado — solo si hay lux */}
        {lux !== null && (
          <>
            <View style={s.fila}>
              <View style={[s.tarjeta, { flex: 1 }]}>
                <Text style={s.tarjetaIcon}>⚡</Text>
                <Text style={s.tarjetaLabel}>PPFD EST.</Text>
                <Text style={[s.tarjetaValor, { color: '#3B8BD4', fontSize: 16 }]}>
                  {ppfd.toFixed(1)}
                </Text>
                <Text style={proy.unidadChica}>µmol/m²/s</Text>
              </View>
              <View style={[s.tarjeta, { flex: 1 }]}>
                <Text style={s.tarjetaIcon}>📅</Text>
                <Text style={s.tarjetaLabel}>DLI EST.</Text>
                <Text style={[s.tarjetaValor, { color: getColorDLI(dli), fontSize: 16 }]}>
                  {dli.toFixed(2)}
                </Text>
                <Text style={proy.unidadChica}>mol/m²/día</Text>
              </View>
              <View style={[s.tarjeta, { flex: 1 }]}>
                <Text style={s.tarjetaIcon}>🔢</Text>
                <Text style={s.tarjetaLabel}>K ESPECTRO</Text>
                <Text style={[s.tarjetaValor, { color: '#1D9E75', fontSize: 16 }]}>
                  {ks}
                </Text>
                <Text style={proy.unidadChica}>factor</Text>
              </View>
            </View>

            {/* Barra DLI */}
            <View style={s.chartCard}>
              <View style={s.chartHeader}>
                <Text style={s.chartTitulo}>Índice DLI estimado</Text>
                <Text style={[s.linkBtn, { color: getColorDLI(dli) }]}>
                  {dli < 5 ? 'Muy bajo' : dli < 15 ? 'Moderado' : dli < 30 ? 'Óptimo' : 'Alto'}
                </Text>
              </View>
              <View style={proy.barraFondo}>
                <View style={[proy.barraRelleno, {
                  width: `${Math.min((dli / 60) * 100, 100)}%`,
                  backgroundColor: getColorDLI(dli),
                }]} />
              </View>
              <View style={proy.barraEtiquetas}>
                {[0, 5, 15, 30, 60].map(v => (
                  <Text key={v} style={proy.barraEtiquetaTexto}>{v}</Text>
                ))}
              </View>
              <Text style={s.chartNota}>
                mol/m²/día · &lt;5 bajo · 5–15 moderado · 15–30 óptimo para cultivo
              </Text>
            </View>
          </>
        )}

        {/* Fórmula */}
        <View style={s.chartCard}>
          <Text style={s.chartTitulo}>📐 Fórmula utilizada</Text>
          <View style={proy.formulaBox}>
            <Text style={proy.formulaTexto}>PPFD = Lux × Kₛ</Text>
            <Text style={proy.formulaTexto}>DLI  = Lux × Kₛ × H × 0.0036</Text>
          </View>
          <Text style={[s.chartNota, { marginTop: 8 }]}>
            Kₛ varía según el espectro de la fuente · Apogee Instruments
          </Text>
        </View>

        {/* Nota técnica */}
        <View style={[s.alertaBox, { borderLeftColor: '#3B8BD4', backgroundColor: '#e8f4fd' }]}>
          <Text style={[s.alertaTexto, { color: '#1a5276' }]}>
            ℹ️ El sensor del celular mide lux aproximados. Para mayor precisión,
            calibrar con un luxómetro de referencia y ajustar con un factor Kcal adicional.
          </Text>
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
  container:      { flex: 1, backgroundColor: '#f5f7fb' },
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
const proy = StyleSheet.create({
  chip:            { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 20, backgroundColor: '#f5f5f5', alignItems: 'center', minWidth: 100 },
  chipActivo:      { backgroundColor: '#007AFF' },
  chipTexto:       { fontSize: 13, fontWeight: '600', color: '#555' },
  chipTextoActivo: { color: '#fff' },
  chipSub:         { fontSize: 10, color: '#aaa', marginTop: 2 },

  input:           { fontSize: 22, fontWeight: 'bold', color: '#1a1a1a', marginTop: 8, marginBottom: 2 },
  inputUnidad:     { fontSize: 11, color: '#aaa', fontWeight: '600' },
  unidadChica:     { fontSize: 9, color: '#aaa', marginTop: 2 },

  barraFondo:      { height: 12, backgroundColor: '#f0f0f0', borderRadius: 6, overflow: 'hidden', marginTop: 10 },
  barraRelleno:    { height: '100%', borderRadius: 6 },
  barraEtiquetas:  { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 },
  barraEtiquetaTexto: { fontSize: 10, color: '#bbb' },

  formulaBox:      { backgroundColor: '#f8f8f8', borderRadius: 10, padding: 14, marginTop: 10, gap: 6 },
  formulaTexto:    { fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace', fontSize: 14, color: '#333', fontWeight: '600' },
});
const proy_nuevos = StyleSheet.create({
  botonGuia: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#E0F2E9',
    shadowColor: '#000',
    shadowOpacity: 0.04,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
    gap: 12,
  },
  botonGuiaIcono:  { fontSize: 24 },
  botonGuiaTitulo: { fontSize: 15, fontWeight: '700', color: '#1A1A1A' },
  botonGuiaSub:    { fontSize: 12, color: '#888', marginTop: 2 },
  botonGuiaChevron:{ fontSize: 24, color: '#CCC', fontWeight: '300' },
});