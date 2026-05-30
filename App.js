import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  StyleSheet, Text, View, TouchableOpacity, ScrollView,
  SafeAreaView, ActivityIndicator, Switch, Share, Platform,
  Vibration, Alert, TextInput, PermissionsAndroid, FlatList,
} from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { LineChart } from 'react-native-gifted-charts';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LightSensor } from 'expo-sensors';
import { Modal } from 'react-native';
import { LogBox } from 'react-native';
import { BleManager, State } from 'react-native-ble-plx';

LogBox.ignoreLogs(['Possible Unhandled Promise']);

// ══════════════════════════════════════════════════════════════════════
//  BLUETOOTH — UUIDs (deben coincidir con el código Arduino del ESP32)
// ══════════════════════════════════════════════════════════════════════
const ESP32_SERVICE_UUID = '4fafc201-1fb5-459e-8fcc-c5c9c331914b';
const ESP32_CHAR_UUID    = 'beb5483e-36e1-4688-b7f5-ea07361b26a8';
const BT_DEVICE_KEY      = 'bt_device_id';

// Instancia global del manager BLE
const bleManager = new BleManager();

// ──────────────────────────────────────────────────────────────────────
//  Helpers BLE
// ──────────────────────────────────────────────────────────────────────
async function requestBluetoothPermissions() {
  if (Platform.OS !== 'android') return true;
  try {
    if (Platform.Version >= 31) {
      // Android 12+
      const granted = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      ]);
      return (
        granted[PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN]    === PermissionsAndroid.RESULTS.GRANTED &&
        granted[PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT] === PermissionsAndroid.RESULTS.GRANTED
      );
    } else {
      // Android 11 e inferior
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
      );
      return granted === PermissionsAndroid.RESULTS.GRANTED;
    }
  } catch {
    return false;
  }
}

function base64ToUtf8(base64) {
  try {
    return decodeURIComponent(
      atob(base64)
        .split('')
        .map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    );
  } catch {
    return atob(base64);
  }
}

async function getSavedDeviceId() {
  try {
    return await AsyncStorage.getItem(BT_DEVICE_KEY);
  } catch {
    return null;
  }
}

async function saveDeviceId(id) {
  await AsyncStorage.setItem(BT_DEVICE_KEY, id);
}

// ══════════════════════════════════════════════════════════════════════
//  SUPABASE
// ══════════════════════════════════════════════════════════════════════
const SUPABASE_URL  = 'https://xezrsaxatclqoadymalm.supabase.co';
const SUPABASE_ANON = 'sb_publishable_MqtmstW_6bMGlM6-q7-a_Q_-L6VYWyU';

const ALERTAS = {
  dht_temp:  { min: 10, max: 35, label: 'Temp DHT' },
  dht_hum:   { min: 20, max: 85, label: 'Humedad' },
  lm35_temp: { min: 10, max: 35, label: 'Temp LM35' },
};

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
//  HELPERS GENERALES
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
//  CONTEXTO BLUETOOTH (compartido entre pantallas)
// ══════════════════════════════════════════════════════════════════════
const BleContext = React.createContext(null);

function BleProvider({ children }) {
  const [deviceConectado, setDeviceConectado] = useState(null); // objeto Device de BLE
  const [bleReady, setBleReady]               = useState(false);
  const deviceRef = useRef(null);

  // Esperar a que el BLE esté encendido
  useEffect(() => {
    const sub = bleManager.onStateChange((state) => {
      if (state === State.PoweredOn) {
        setBleReady(true);
        sub.remove();
      }
    }, true);
    return () => sub.remove();
  }, []);

  const conectar = useCallback(async (device) => {
    try {
      const connected = await bleManager.connectToDevice(device.id);
      await connected.discoverAllServicesAndCharacteristics();
      deviceRef.current = connected;
      setDeviceConectado(connected);
      await saveDeviceId(device.id);

      // Detectar desconexión
      bleManager.onDeviceDisconnected(device.id, () => {
        deviceRef.current = null;
        setDeviceConectado(null);
      });

      return true;
    } catch (e) {
      console.warn('Error conectando:', e.message);
      return false;
    }
  }, []);

  const desconectar = useCallback(async () => {
    if (deviceRef.current) {
      try { await bleManager.cancelDeviceConnection(deviceRef.current.id); } catch {}
      deviceRef.current = null;
      setDeviceConectado(null);
    }
  }, []);

  // Leer datos del ESP32 vía BLE
  const leerSensores = useCallback(async () => {
    if (!deviceRef.current) throw new Error('No hay dispositivo BLE conectado');
    const char = await deviceRef.current.readCharacteristicForService(
      ESP32_SERVICE_UUID,
      ESP32_CHAR_UUID
    );
    const texto = base64ToUtf8(char.value);
    return JSON.parse(texto);
  }, []);

  return (
    <BleContext.Provider value={{ deviceConectado, bleReady, conectar, desconectar, leerSensores }}>
      {children}
    </BleContext.Provider>
  );
}

// ══════════════════════════════════════════════════════════════════════
//  PANTALLA MONITOREO
// ══════════════════════════════════════════════════════════════════════
function PantallaMonitoreo() {
  const { deviceConectado, leerSensores } = React.useContext(BleContext);

  const [lectura, setLectura]                     = useState(null);
  const [historial, setHistorial]                 = useState([]);
  const [cargando, setCargando]                   = useState(false);
  const [cargandoHistorial, setCargandoHistorial] = useState(false);
  const [error, setError]                         = useState(null);
  const [alertas, setAlertas]                     = useState([]);
  const [autoSync, setAutoSync]                   = useState(false);
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

    if (!deviceConectado) {
      // Sin BT conectado → datos simulados
      const sim = {
        dht_temp:  parseFloat((Math.random() * 15 + 20).toFixed(2)),
        dht_hum:   parseFloat((Math.random() * 40 + 40).toFixed(2)),
        lm35_temp: parseFloat((Math.random() * 15 + 18).toFixed(2)),
      };
      setLectura(sim);
      setError('⚠️ Sin Bluetooth conectado — datos simulados');
      setCargando(false);
      return;
    }

    try {
      const json = await leerSensores();

      if (!json.ok) { setError('ESP32: error en sensores'); setCargando(false); return; }

      const datos = {
        dht_temp:  parseFloat(json.dht_temp),
        dht_hum:   parseFloat(json.dht_hum),
        lm35_temp: parseFloat(json.lm35_temp),
      };

      if (!validarLectura(datos)) { setError('Datos fuera de rango'); setCargando(false); return; }

      setLectura(datos);
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
      setError(`Error BLE: ${e.message}`);
    } finally {
      setCargando(false);
    }
  }, [cargando, deviceConectado, leerSensores]);

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
  const conectado   = !!deviceConectado;

  return (
    <SafeAreaView style={s.container}>
      <ScrollView contentContainerStyle={s.scroll}>

        {/* Header */}
        <View style={s.header}>
          <View>
            <Text style={s.titulo}>Monitor ESP32</Text>
            <Text style={s.subtitulo}>
              {!conectado ? 'Bluetooth desconectado' :
              `BT conectado · ${ultimaVez ? formatHora(ultimaVez.toISOString()) : 'sin sincronizar'}`}
            </Text>
          </View>
          <View style={[s.estadoBadge, {
            backgroundColor: conectado ? '#e8f5e9' : '#fff3e0'
          }]}>
            <View style={[s.estadoPunto, {
              backgroundColor: conectado ? '#4CAF50' : '#FF9800'
            }]} />
            <Text style={[s.estadoTexto, {
              color: conectado ? '#2E7D32' : '#E65100'
            }]}>
              {conectado ? '🔵 BT On' : '🔴 BT Off'}
            </Text>
          </View>
        </View>

        {/* Aviso si no hay BT */}
        {!conectado && (
          <View style={[s.alertaBox, { borderLeftColor: '#FF9800', backgroundColor: '#fff8e1', marginBottom: 14 }]}>
            <Text style={[s.alertaTexto, { color: '#E65100' }]}>
              📡 Ve a la pestaña <Text style={{ fontWeight: '700' }}>Bluetooth</Text> para conectar el ESP32.
            </Text>
          </View>
        )}

        {/* Tarjetas sensores */}
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

        {alertas.length > 0 && (
          <View style={s.alertaBox}>
            {alertas.map((a, i) => <Text key={i} style={s.alertaTexto}>{a}</Text>)}
          </View>
        )}

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
                {autoSync ? '⟳ Auto-sync activo' : '🔵 Sincronizar por Bluetooth'}
              </Text>
          }
        </TouchableOpacity>

      </ScrollView>
    </SafeAreaView>
  );
}

// ══════════════════════════════════════════════════════════════════════
//  MODAL EDUCATIVO (Sensor de Luz) — sin cambios
// ══════════════════════════════════════════════════════════════════════
function ModalComoFunciona({ visible, onClose }) {
  const conceptos = [
    {
      icono: '💡',
      titulo: 'Lux — la cantidad de luz que llega',
      tag: 'Lo que mide el sensor del celular',
      tagColor: '#FEF3C7', tagTexto: '#92400E',
      cuerpo: 'El lux mide cuánta luz visible recibe una superficie. Un cuarto oscuro tiene ~50 lux, una oficina ~500 lux y el sol directo puede superar los 100 000 lux.',
      analogia: '💬 Piénsalo como el caudal de una manguera: los lux dicen cuánta agua sale, pero no si esa agua sirve para tu planta.',
      analogiaColor: '#FFF8E1', analogiaBorde: '#F59E0B',
    },
    {
      icono: '⚡',
      titulo: 'PPFD — la luz que las plantas realmente aprovechan',
      tag: 'Calculado desde los lux',
      tagColor: '#D1FAE5', tagTexto: '#065F46',
      cuerpo: 'Las plantas solo absorben ciertas longitudes de onda para la fotosíntesis. El PPFD mide esos fotones útiles en µmol/m²/s.',
      analogia: '💬 Es como filtrar el agua: el PPFD solo cuenta las gotas que la planta puede "beber" para crecer.',
      analogiaColor: '#E8F5E9', analogiaBorde: '#1D9E75',
    },
    {
      icono: '📅',
      titulo: 'DLI — la dosis diaria de luz',
      tag: 'El dato más útil para el cultivo',
      tagColor: '#EDE9FE', tagTexto: '#4C1D95',
      cuerpo: 'El DLI acumula todo el PPFD recibido durante el día. Si el PPFD es la velocidad, el DLI es la distancia total. Se mide en mol/m²/día.',
      analogia: '💬 Menos de 5 = muy bajo · 5–15 = moderado · 15–30 = óptimo · +30 = alto',
      analogiaColor: '#F3E8FF', analogiaBorde: '#7C3AED',
    },
  ];

  const plantas = [
    { nombre: 'Suculentas / cactus',  rango: '20–30', color: '#E24B4A' },
    { nombre: 'Tomates / pimientos',  rango: '22–30', color: '#F59E0B' },
    { nombre: 'Lechuga / espinaca',   rango: '12–17', color: '#22C55E' },
    { nombre: 'Albahaca / hierbas',   rango: '12–20', color: '#1D9E75' },
    { nombre: 'Orquídeas',            rango: '6–12',  color: '#7C3AED' },
    { nombre: 'Plantas de interior',  rango: '4–8',   color: '#378ADD' },
  ];

  const pasos = [
    'Coloca el celular donde está la planta, con la cámara apuntando hacia la fuente de luz.',
    'Toca "Medir Lux ahora". La app promedia 5 lecturas seguidas para mayor precisión.',
    'Elige el tipo de lámpara: solar, LED, fluorescente, HPS o Metal Halide.',
    'Indica cuántas horas al día está encendida la luz.',
    'Lee el DLI y compáralo con el rango ideal de tu planta en la tabla.',
  ];

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: '#F5F5F5' }}>
        <View style={m.modalHeader}>
          <View>
            <Text style={m.modalTitulo}>¿Cómo funciona?</Text>
            <Text style={m.modalSubtitulo}>Guía de mediciones · Lux → PPFD → DLI</Text>
          </View>
          <TouchableOpacity onPress={onClose} style={m.cerrarBtn}>
            <Text style={m.cerrarTexto}>✕ Cerrar</Text>
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
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
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const m = StyleSheet.create({
  modalHeader:    { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#E8E8E8' },
  modalTitulo:    { fontSize: 18, fontWeight: '700', color: '#1A1A1A' },
  modalSubtitulo: { fontSize: 13, color: '#888', marginTop: 2 },
  cerrarBtn:      { backgroundColor: '#F0F0F0', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20 },
  cerrarTexto:    { fontSize: 14, color: '#555', fontWeight: '600' },
  seccion:        { fontSize: 13, fontWeight: '700', color: '#555', marginBottom: 10, marginTop: 4, textTransform: 'uppercase', letterSpacing: 0.5 },
  card:           { backgroundColor: '#fff', borderRadius: 12, padding: 16, marginBottom: 12, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 4, shadowOffset: { width: 0, height: 2 }, elevation: 2 },
  cardHeaderRow:  { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 10 },
  cardTitulo:     { fontSize: 15, fontWeight: '700', color: '#1A1A1A', lineHeight: 20 },
  tag:            { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 20, marginTop: 4 },
  tagTexto:       { fontSize: 11, fontWeight: '600' },
  cardCuerpo:     { fontSize: 14, color: '#444', lineHeight: 22 },
  analogia:       { borderLeftWidth: 3, borderRadius: 4, padding: 10, marginTop: 10 },
  analogiaTexto:  { fontSize: 13, color: '#555', lineHeight: 20 },
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
//  PANTALLA PROYECTO (Sensor de Luz + Bluetooth)
// ══════════════════════════════════════════════════════════════════════
function PantallaProyecto() {
  const { deviceConectado, bleReady, conectar, desconectar } = React.useContext(BleContext);

  const [tabActiva, setTabActiva] = useState('luz');

  // ── Sensor de luz ────────────────────────────────────────────────
  const [lux, setLux]               = useState(null);
  const [midiendo, setMidiendo]     = useState(false);
  const [horasInput, setHorasInput] = useState('12');
  const [tipoLuz, setTipoLuz]       = useState(0);
  const [errorLuz, setErrorLuz]     = useState(null);
  const [modalVisible, setModalVisible] = useState(false);
  const suscripcionRef              = useRef(null);
  const muestrasRef                 = useRef([]);

  // ── Bluetooth ────────────────────────────────────────────────────
  const [escaneando, setEscaneando]     = useState(false);
  const [dispositivos, setDispositivos] = useState([]);
  const [conectando, setConectando]     = useState(false);
  const [errorBle, setErrorBle]         = useState(null);
  const dispositivosRef = useRef({});

  // ── Lógica sensor ────────────────────────────────────────────────
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
    if (suscripcionRef.current) { suscripcionRef.current.remove(); suscripcionRef.current = null; }
    setMidiendo(false);
  };

  const iniciarMedicion = async () => {
    setErrorLuz(null);
    const disponible = await LightSensor.isAvailableAsync();
    if (!disponible) { setErrorLuz('❌ Este dispositivo no tiene sensor de luz ambiental'); return; }
    const { status } = await LightSensor.requestPermissionsAsync();
    if (status !== 'granted') { setErrorLuz('❌ Permiso denegado — actívalo en Configuración > Apps > Permisos'); return; }
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
      setErrorLuz(`❌ Error al iniciar sensor: ${e.message}`);
      detenerMedicion();
    }
  };

  useEffect(() => () => detenerMedicion(), []);

  // ── Lógica Bluetooth ─────────────────────────────────────────────
  const iniciarEscaneo = async () => {
    setErrorBle(null);
    const ok = await requestBluetoothPermissions();
    if (!ok) { setErrorBle('❌ Permisos de Bluetooth denegados'); return; }
    if (!bleReady) { setErrorBle('❌ Bluetooth apagado — actívalo en el celular'); return; }

    dispositivosRef.current = {};
    setDispositivos([]);
    setEscaneando(true);

    bleManager.startDeviceScan(null, { allowDuplicates: false }, (error, device) => {
      if (error) {
        setErrorBle(`Error escaneando: ${error.message}`);
        setEscaneando(false);
        return;
      }
      if (device && device.name && !dispositivosRef.current[device.id]) {
        dispositivosRef.current[device.id] = device;
        setDispositivos(Object.values(dispositivosRef.current));
      }
    });

    setTimeout(() => {
      bleManager.stopDeviceScan();
      setEscaneando(false);
    }, 8000);
  };

  const detenerEscaneo = () => {
    bleManager.stopDeviceScan();
    setEscaneando(false);
  };

  const handleConectar = async (device) => {
    setConectando(true);
    setErrorBle(null);
    const ok = await conectar(device);
    if (!ok) setErrorBle(`❌ No se pudo conectar a ${device.name}`);
    setConectando(false);
  };

  const handleDesconectar = async () => {
    await desconectar();
  };

  // ── Render ───────────────────────────────────────────────────────
  return (
    <SafeAreaView style={s.container}>
      <ModalComoFunciona visible={modalVisible} onClose={() => setModalVisible(false)} />

      {/* Selector de sub-tab */}
      <View style={proy.tabSelector}>
        {[
          { key: 'luz',       label: '🌿 Sensor Luz' },
          { key: 'bluetooth', label: '🔵 Bluetooth' },
        ].map(({ key, label }) => (
          <TouchableOpacity
            key={key}
            style={[proy.tabBtn, tabActiva === key && proy.tabBtnActivo]}
            onPress={() => setTabActiva(key)}
          >
            <Text style={[proy.tabBtnTexto, tabActiva === key && proy.tabBtnTextoActivo]}>
              {label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* ── TAB: SENSOR DE LUZ ── */}
      {tabActiva === 'luz' && (
        <ScrollView contentContainerStyle={s.scroll}>
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

          <TouchableOpacity style={proy.botonGuia} onPress={() => setModalVisible(true)} activeOpacity={0.75}>
            <Text style={proy.botonGuiaIcono}>📖</Text>
            <View style={{ flex: 1 }}>
              <Text style={proy.botonGuiaTitulo}>¿Cómo funciona?</Text>
              <Text style={proy.botonGuiaSub}>Qué son Lux, PPFD y DLI · Guía paso a paso</Text>
            </View>
            <Text style={proy.botonGuiaChevron}>›</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[s.boton, midiendo && s.botonOff, { marginBottom: 14 }]}
            onPress={midiendo ? detenerMedicion : iniciarMedicion}
          >
            {midiendo
              ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <ActivityIndicator color="#fff" />
                  <Text style={s.botonTexto}>Midiendo... toca para cancelar</Text>
                </View>
              : <Text style={s.botonTexto}>
                  {lux !== null ? `☀️ Volver a medir  (${lux} lux)` : '☀️ Medir Lux ahora'}
                </Text>
            }
          </TouchableOpacity>

          {lux !== null && (
            <View style={[s.chartCard, { alignItems: 'center', marginBottom: 14 }]}>
              <Text style={[s.tarjetaLabel, { marginBottom: 4 }]}>LUX MEDIDOS</Text>
              <Text style={[s.tarjetaValor, { fontSize: 40, color: '#FF9800' }]}>{lux}</Text>
              <Text style={proy.unidadChica}>lux · promedio de 5 muestras</Text>
            </View>
          )}

          {errorLuz && (
            <View style={s.errorBox}><Text style={s.errorTexto}>{errorLuz}</Text></View>
          )}

          <View style={s.chartCard}>
            <Text style={s.chartTitulo}>Tipo de fuente de luz</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 10 }}>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {fuentes.map((f, i) => (
                  <TouchableOpacity key={i} onPress={() => setTipoLuz(i)} style={[proy.chip, tipoLuz === i && proy.chipActivo]}>
                    <Text style={[proy.chipTexto, tipoLuz === i && proy.chipTextoActivo]}>{f.label}</Text>
                    <Text style={[proy.chipSub, tipoLuz === i && { color: '#fff' }]}>Kₛ = {f.ks}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </ScrollView>
          </View>

          <View style={[s.chartCard, { marginBottom: 14 }]}>
            <Text style={s.chartTitulo}>Horas de luz por día</Text>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              {[6, 8, 10, 12, 14, 16, 18].map(h => (
                <TouchableOpacity key={h} onPress={() => setHorasInput(String(h))} style={[proy.chip, String(h) === horasInput && proy.chipActivo]}>
                  <Text style={[proy.chipTexto, String(h) === horasInput && proy.chipTextoActivo]}>{h}h</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          {lux !== null && (
            <>
              <View style={s.fila}>
                {[
                  { icon: '⚡', label: 'PPFD EST.',   valor: ppfd.toFixed(1), unidad: 'µmol/m²/s', color: '#3B8BD4' },
                  { icon: '📅', label: 'DLI EST.',    valor: dli.toFixed(2),  unidad: 'mol/m²/día', color: getColorDLI(dli) },
                  { icon: '🔢', label: 'K ESPECTRO',  valor: ks,              unidad: 'factor',      color: '#1D9E75' },
                ].map(({ icon, label, valor, unidad, color }) => (
                  <View key={label} style={[s.tarjeta, { flex: 1 }]}>
                    <Text style={s.tarjetaIcon}>{icon}</Text>
                    <Text style={s.tarjetaLabel}>{label}</Text>
                    <Text style={[s.tarjetaValor, { color, fontSize: 16 }]}>{valor}</Text>
                    <Text style={proy.unidadChica}>{unidad}</Text>
                  </View>
                ))}
              </View>

              <View style={s.chartCard}>
                <View style={s.chartHeader}>
                  <Text style={s.chartTitulo}>Índice DLI estimado</Text>
                  <Text style={[s.linkBtn, { color: getColorDLI(dli) }]}>
                    {dli < 5 ? 'Muy bajo' : dli < 15 ? 'Moderado' : dli < 30 ? 'Óptimo' : 'Alto'}
                  </Text>
                </View>
                <View style={proy.barraFondo}>
                  <View style={[proy.barraRelleno, { width: `${Math.min((dli / 60) * 100, 100)}%`, backgroundColor: getColorDLI(dli) }]} />
                </View>
                <View style={proy.barraEtiquetas}>
                  {[0, 5, 15, 30, 60].map(v => <Text key={v} style={proy.barraEtiquetaTexto}>{v}</Text>)}
                </View>
                <Text style={s.chartNota}>mol/m²/día · &lt;5 bajo · 5–15 moderado · 15–30 óptimo para cultivo</Text>
              </View>
            </>
          )}

          <View style={s.chartCard}>
            <Text style={s.chartTitulo}>📐 Fórmula utilizada</Text>
            <View style={proy.formulaBox}>
              <Text style={proy.formulaTexto}>PPFD = Lux × Kₛ</Text>
              <Text style={proy.formulaTexto}>DLI  = Lux × Kₛ × H × 0.0036</Text>
            </View>
            <Text style={[s.chartNota, { marginTop: 8 }]}>Kₛ varía según el espectro de la fuente · Apogee Instruments</Text>
          </View>
        </ScrollView>
      )}

      {/* ── TAB: BLUETOOTH ── */}
      {tabActiva === 'bluetooth' && (
        <ScrollView contentContainerStyle={s.scroll}>
          <View style={s.header}>
            <View>
              <Text style={s.titulo}>Bluetooth</Text>
              <Text style={s.subtitulo}>Conexión con el ESP32 vía BLE</Text>
            </View>
            <View style={[s.estadoBadge, {
              backgroundColor: deviceConectado ? '#e8f5e9' : '#f0f0f0'
            }]}>
              <View style={[s.estadoPunto, {
                backgroundColor: deviceConectado ? '#4CAF50' : '#aaa'
              }]} />
              <Text style={[s.estadoTexto, {
                color: deviceConectado ? '#2E7D32' : '#888'
              }]}>
                {deviceConectado ? 'Conectado' : 'Offline'}
              </Text>
            </View>
          </View>

          {/* Estado conexión actual */}
          {deviceConectado && (
            <View style={[s.chartCard, { marginBottom: 14 }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <Text style={{ fontSize: 32 }}>🔵</Text>
                <View style={{ flex: 1 }}>
                  <Text style={[s.controlLabel, { color: '#2E7D32' }]}>
                    {deviceConectado.name ?? 'ESP32'}
                  </Text>
                  <Text style={s.controlSub}>{deviceConectado.id}</Text>
                </View>
              </View>
              <TouchableOpacity
                style={[s.boton, { backgroundColor: '#E53935', marginTop: 14 }]}
                onPress={handleDesconectar}
              >
                <Text style={s.botonTexto}>⛔ Desconectar</Text>
              </TouchableOpacity>
            </View>
          )}

          {errorBle && (
            <View style={s.errorBox}>
              <Text style={s.errorTexto}>{errorBle}</Text>
            </View>
          )}

          {/* Botón escanear */}
          {!deviceConectado && (
            <TouchableOpacity
              style={[s.boton, escaneando && s.botonOff, { marginBottom: 14 }]}
              onPress={escaneando ? detenerEscaneo : iniciarEscaneo}
              disabled={conectando}
            >
              {escaneando
                ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <ActivityIndicator color="#fff" />
                    <Text style={s.botonTexto}>Buscando... (toca para detener)</Text>
                  </View>
                : <Text style={s.botonTexto}>🔍 Buscar dispositivos BLE</Text>
              }
            </TouchableOpacity>
          )}

          {/* Lista de dispositivos */}
          {dispositivos.length > 0 && !deviceConectado && (
            <View style={s.tablaCard}>
              <Text style={s.chartTitulo}>Dispositivos encontrados</Text>
              {dispositivos.map((dev) => (
                <View key={dev.id} style={[proy.devFila]}>
                  <View style={{ flex: 1 }}>
                    <Text style={proy.devNombre}>{dev.name}</Text>
                    <Text style={proy.devId}>{dev.id}</Text>
                  </View>
                  <TouchableOpacity
                    style={[proy.conectarBtn, conectando && { opacity: 0.5 }]}
                    onPress={() => handleConectar(dev)}
                    disabled={conectando}
                  >
                    {conectando
                      ? <ActivityIndicator color="#fff" size="small" />
                      : <Text style={proy.conectarBtnTexto}>Conectar</Text>
                    }
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          )}

          {dispositivos.length === 0 && !escaneando && !deviceConectado && (
            <View style={[s.alertaBox, { borderLeftColor: '#aaa', backgroundColor: '#fafafa' }]}>
              <Text style={[s.alertaTexto, { color: '#888' }]}>
                Pulsa "Buscar dispositivos BLE" para encontrar el ESP32. Asegúrate de que el ESP32 esté encendido y cerca.
              </Text>
            </View>
          )}

          {/* Guía de configuración */}
          <View style={s.tablaCard}>
            <Text style={s.chartTitulo}>📋 Guía de conexión</Text>
            {[
              ['1', 'Sube el nuevo firmware BLE al ESP32 (ver archivo ESP32_BLE.ino)'],
              ['2', 'Enciende el ESP32 — el LED azul parpadeará indicando que BLE está activo'],
              ['3', 'Pulsa "Buscar dispositivos BLE" en esta pantalla'],
              ['4', 'Selecciona "ESP32_Sensores" de la lista'],
              ['5', 'Una vez conectado, ve a Monitor y pulsa Sincronizar'],
            ].map(([n, texto]) => (
              <View key={n} style={{ flexDirection: 'row', gap: 10, marginVertical: 5, alignItems: 'flex-start' }}>
                <View style={{ width: 22, height: 22, borderRadius: 11, marginTop: 1, backgroundColor: '#007AFF', alignItems: 'center', justifyContent: 'center' }}>
                  <Text style={{ color: '#fff', fontSize: 11, fontWeight: '700' }}>{n}</Text>
                </View>
                <Text style={{ flex: 1, color: '#444', fontSize: 13, lineHeight: 20 }}>{texto}</Text>
              </View>
            ))}
          </View>

          <View style={[s.alertaBox, { borderLeftColor: '#007AFF', backgroundColor: '#e8f4fd' }]}>
            <Text style={[s.alertaTexto, { color: '#1a5276' }]}>
              💡 El ESP32 se recuerda entre sesiones. Solo necesitas volver a buscar si cambias de dispositivo o reinicias el celular.
            </Text>
          </View>
        </ScrollView>
      )}

    </SafeAreaView>
  );
}

// ══════════════════════════════════════════════════════════════════════
//  NAVEGACIÓN
// ══════════════════════════════════════════════════════════════════════
const Tab = createBottomTabNavigator();

export default function App() {
  return (
    <BleProvider>
      <NavigationContainer>
        <Tab.Navigator
          screenOptions={({ route }) => ({
            headerShown: false,
            tabBarStyle: s.tabBar,
            tabBarActiveTintColor: '#007AFF',
            tabBarInactiveTintColor: '#aaa',
            tabBarLabelStyle: { fontSize: 12, fontWeight: '500' },
            tabBarIcon: ({ focused }) => {
              const icons = { Monitor: '📡', Proyecto: '🚀' };
              return (
                <Text style={{ fontSize: 20, opacity: focused ? 1 : 0.5 }}>
                  {icons[route.name]}
                </Text>
              );
            },
          })}
        >
          <Tab.Screen name="Monitor"  component={PantallaMonitoreo} />
          <Tab.Screen name="Proyecto" component={PantallaProyecto}  />
        </Tab.Navigator>
      </NavigationContainer>
    </BleProvider>
  );
}

// ══════════════════════════════════════════════════════════════════════
//  ESTILOS
// ══════════════════════════════════════════════════════════════════════
const s = StyleSheet.create({
  container:        { flex: 1, backgroundColor: '#f5f7fb' },
  scroll:           { padding: 16, paddingBottom: 40 },
  header:           { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, marginTop: 8 },
  titulo:           { fontSize: 22, fontWeight: 'bold', color: '#1a1a1a' },
  subtitulo:        { fontSize: 12, color: '#999', marginTop: 2 },
  estadoBadge:      { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 20, gap: 6 },
  estadoPunto:      { width: 8, height: 8, borderRadius: 4 },
  estadoTexto:      { fontSize: 12, fontWeight: '600' },
  fila:             { flexDirection: 'row', gap: 8, marginBottom: 14 },
  tarjeta:          { flex: 1, backgroundColor: '#fff', borderRadius: 14, padding: 12, alignItems: 'center', shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 6, elevation: 3, borderWidth: 0, borderColor: 'transparent' },
  tarjetaIcon:      { fontSize: 18, marginBottom: 4 },
  tarjetaLabel:     { fontSize: 9, fontWeight: '700', color: '#bbb', letterSpacing: 0.8, marginBottom: 4 },
  tarjetaValor:     { fontSize: 18, fontWeight: 'bold' },
  alertIcon:        { fontSize: 12, marginTop: 2 },
  alertaBox:        { backgroundColor: '#fff8e1', borderRadius: 10, padding: 12, marginBottom: 10, borderLeftWidth: 3, borderLeftColor: '#FF9800' },
  alertaTexto:      { color: '#E65100', fontSize: 13, marginBottom: 2 },
  errorBox:         { backgroundColor: '#fff3f3', borderRadius: 10, padding: 12, marginBottom: 10, borderLeftWidth: 3, borderLeftColor: '#E8593C' },
  errorTexto:       { color: '#c0392b', fontSize: 13 },
  chartCard:        { backgroundColor: '#fff', borderRadius: 16, padding: 16, marginBottom: 14, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 6, elevation: 3 },
  chartHeader:      { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  chartTitulo:      { fontSize: 15, fontWeight: '600', color: '#333' },
  linkBtn:          { fontSize: 13, color: '#007AFF' },
  sinDatos:         { color: '#ccc', fontSize: 13, textAlign: 'center', paddingVertical: 30 },
  chartNota:        { fontSize: 11, color: '#ccc', textAlign: 'center', marginTop: 8 },
  tablaCard:        { backgroundColor: '#fff', borderRadius: 16, padding: 16, marginBottom: 14, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 6, elevation: 3 },
  tablaHeader:      { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#f0f0f0', paddingBottom: 6, marginBottom: 4, marginTop: 10 },
  tablaFila:        { flexDirection: 'row', paddingVertical: 5 },
  filaImpar:        { backgroundColor: '#fafafa' },
  celda:            { flex: 1, fontSize: 12, color: '#555', textAlign: 'center' },
  celdaHeader:      { fontWeight: '700', color: '#bbb', fontSize: 11 },
  controlesCard:    { backgroundColor: '#fff', borderRadius: 16, padding: 16, marginBottom: 14, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 6, elevation: 3 },
  controlFila:      { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  controlLabel:     { fontSize: 15, fontWeight: '600', color: '#333' },
  controlSub:       { fontSize: 12, color: '#aaa', marginTop: 2 },
  boton:            { height: 54, backgroundColor: '#007AFF', borderRadius: 14, justifyContent: 'center', alignItems: 'center', shadowColor: '#007AFF', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.25, shadowRadius: 8, elevation: 5 },
  botonOff:         { backgroundColor: '#a0c7ff' },
  botonTexto:       { color: '#fff', fontSize: 16, fontWeight: 'bold' },
  tabBar:           { backgroundColor: '#fff', borderTopColor: '#f0f0f0', borderTopWidth: 0.5, height: 60, paddingBottom: 8 },
});

const proy = StyleSheet.create({
  tabSelector:        { flexDirection: 'row', backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#f0f0f0' },
  tabBtn:             { flex: 1, paddingVertical: 12, alignItems: 'center' },
  tabBtnActivo:       { borderBottomWidth: 2, borderBottomColor: '#007AFF' },
  tabBtnTexto:        { fontSize: 13, fontWeight: '600', color: '#aaa' },
  tabBtnTextoActivo:  { color: '#007AFF' },
  chip:               { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 20, backgroundColor: '#f5f5f5', alignItems: 'center', minWidth: 100 },
  chipActivo:         { backgroundColor: '#007AFF' },
  chipTexto:          { fontSize: 13, fontWeight: '600', color: '#555' },
  chipTextoActivo:    { color: '#fff' },
  chipSub:            { fontSize: 10, color: '#aaa', marginTop: 2 },
  unidadChica:        { fontSize: 9, color: '#aaa', marginTop: 2 },
  barraFondo:         { height: 12, backgroundColor: '#f0f0f0', borderRadius: 6, overflow: 'hidden', marginTop: 10 },
  barraRelleno:       { height: '100%', borderRadius: 6 },
  barraEtiquetas:     { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 },
  barraEtiquetaTexto: { fontSize: 10, color: '#bbb' },
  formulaBox:         { backgroundColor: '#f8f8f8', borderRadius: 10, padding: 14, marginTop: 10, gap: 6 },
  formulaTexto:       { fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace', fontSize: 14, color: '#333', fontWeight: '600' },
  botonGuia:          { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', borderRadius: 12, padding: 14, marginBottom: 14, borderWidth: 1, borderColor: '#E0F2E9', shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 4, shadowOffset: { width: 0, height: 2 }, elevation: 2, gap: 12 },
  botonGuiaIcono:     { fontSize: 24 },
  botonGuiaTitulo:    { fontSize: 15, fontWeight: '700', color: '#1A1A1A' },
  botonGuiaSub:       { fontSize: 12, color: '#888', marginTop: 2 },
  botonGuiaChevron:   { fontSize: 24, color: '#CCC', fontWeight: '300' },
  // Bluetooth
  devFila:            { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#f0f0f0' },
  devNombre:          { fontSize: 14, fontWeight: '600', color: '#333' },
  devId:              { fontSize: 11, color: '#bbb', marginTop: 2 },
  conectarBtn:        { backgroundColor: '#007AFF', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20 },
  conectarBtnTexto:   { color: '#fff', fontSize: 13, fontWeight: '600' },
});