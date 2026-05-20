/*
 * App.js — AppESP32 (sin @supabase/supabase-js, usa fetch directo)
 * ─────────────────────────────────────────────────────────────────────
 * Completar las 3 constantes de configuración abajo.
 * NO necesitas instalar @supabase/supabase-js — desinstálala si ya la tienes:
 *   npm uninstall @supabase/supabase-js @react-native-async-storage/async-storage react-native-url-polyfill
 * ─────────────────────────────────────────────────────────────────────
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  StyleSheet, Text, View, TouchableOpacity,
  ScrollView, SafeAreaView, ActivityIndicator,
} from 'react-native';
import { LineChart } from 'react-native-gifted-charts';

// ══════════════════════════════════════════════════════════════════════
//  CONFIGURACIÓN — completar estos 3 valores
// ══════════════════════════════════════════════════════════════════════
const SUPABASE_URL  = 'https://xezrsaxatclqoadymalm.supabase.co';
const SUPABASE_ANON = 'sb_publishable_MqtmstW_6bMGlM6-q7-a_Q_-L6VYWyU'; // ← pega la key completa
const ESP32_IP      = 'http://192.168.1.50/api/datos';                    // ← cambiar cuando tengas la IP

// ══════════════════════════════════════════════════════════════════════
//  CLIENTE SUPABASE MANUAL (fetch directo, sin librería)
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
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Supabase INSERT error ${res.status}: ${txt}`);
  }
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
  const d = new Date(iso);
  return d.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
}

// ══════════════════════════════════════════════════════════════════════
//  COMPONENTE PRINCIPAL
// ══════════════════════════════════════════════════════════════════════
export default function App() {
  const [lectura, setLectura]                   = useState(null);
  const [historial, setHistorial]               = useState([]);
  const [cargando, setCargando]                 = useState(false);
  const [cargandoHistorial, setCargandoHistorial] = useState(false);
  const [error, setError]                       = useState(null);

  // ── Cargar historial desde Supabase ───────────────────────────────
  const cargarHistorial = useCallback(async () => {
    setCargandoHistorial(true);
    try {
      const data = await sbSelect(
        'lectura',
        'select=dht_temp,dht_hum,lm35_temp,timestamp&order=timestamp.desc&limit=20'
      );
      setHistorial(data.reverse());
    } catch (e) {
      console.warn('Error cargando historial:', e.message);
    } finally {
      setCargandoHistorial(false);
    }
  }, []);

  // ── Guardar lectura en Supabase ───────────────────────────────────
  const guardarEnSupabase = async (datos) => {
    try {
      await sbInsert('lectura', {
        dht_temp:  datos.dht_temp,
        dht_hum:   datos.dht_hum,
        lm35_temp: datos.lm35_temp,
      });
      cargarHistorial();
    } catch (e) {
      console.warn('Error guardando:', e.message);
    }
  };

  // ── Obtener datos del ESP32 ───────────────────────────────────────
  const sincronizar = async () => {
    setCargando(true);
    setError(null);
    try {
      const response = await fetch(ESP32_IP, {
        signal: AbortSignal.timeout(5000),
      });
      const json = await response.json();

      if (!json.ok) {
        setError('El ESP32 reportó error en sensores');
        return;
      }

      const datos = {
        dht_temp:  parseFloat(json.dht_temp),
        dht_hum:   parseFloat(json.dht_hum),
        lm35_temp: parseFloat(json.lm35_temp),
      };

      if (!validarLectura(datos)) {
        setError('Datos fuera de rango físico, lectura descartada');
        return;
      }

      setLectura(datos);
      await guardarEnSupabase(datos);

    } catch (e) {
      console.warn('Sin conexión al ESP32 — simulando:', e.message);
      const sim = {
        dht_temp:  parseFloat((Math.random() * 15 + 20).toFixed(2)),
        dht_hum:   parseFloat((Math.random() * 40 + 40).toFixed(2)),
        lm35_temp: parseFloat((Math.random() * 15 + 18).toFixed(2)),
      };
      setLectura(sim);
      setError('⚠️ Sin conexión al ESP32 — datos simulados (no guardados)');
    } finally {
      setCargando(false);
    }
  };

  useEffect(() => { cargarHistorial(); }, [cargarHistorial]);

  const datosGrafico = historial.map((r, i) => ({
    value: r.dht_temp,
    label: i % 5 === 0 ? formatHora(r.timestamp) : '',
  }));

  return (
    <SafeAreaView style={s.container}>
      <ScrollView contentContainerStyle={s.scroll}>

        <Text style={s.titulo}>Estación de Sensores</Text>
        <Text style={s.subtitulo}>ESP32 + Supabase</Text>

        <View style={s.fila}>
          <TarjetaValor etiqueta="TEMP DHT"  valor={lectura ? `${lectura.dht_temp.toFixed(1)}°C`  : '—'} color="#E8593C" />
          <TarjetaValor etiqueta="HUMEDAD"   valor={lectura ? `${lectura.dht_hum.toFixed(1)}%`    : '—'} color="#3B8BD4" />
          <TarjetaValor etiqueta="TEMP LM35" valor={lectura ? `${lectura.lm35_temp.toFixed(1)}°C` : '—'} color="#1D9E75" />
        </View>

        {error && (
          <View style={s.errorBox}>
            <Text style={s.errorText}>{error}</Text>
          </View>
        )}

        <View style={s.chartCard}>
          <View style={s.chartHeader}>
            <Text style={s.chartTitulo}>Historial — Temp DHT (°C)</Text>
            <TouchableOpacity onPress={cargarHistorial} disabled={cargandoHistorial}>
              <Text style={s.refrescarBtn}>{cargandoHistorial ? 'Cargando...' : '↻ Refrescar'}</Text>
            </TouchableOpacity>
          </View>
          {datosGrafico.length > 1 ? (
            <LineChart
              data={datosGrafico}
              color="#E8593C"
              thickness={2.5}
              dataPointsColor="#E8593C"
              radius={4}
              spacing={32}
              hideRules={false}
              rulesColor="#f0f0f0"
              yAxisColor="#ddd"
              xAxisColor="#ddd"
              yAxisTextStyle={{ color: '#999', fontSize: 10 }}
              xAxisLabelTextStyle={{ color: '#999', fontSize: 9 }}
            />
          ) : (
            <Text style={s.sinDatos}>
              {cargandoHistorial ? 'Cargando historial...' : 'Sin datos aún — sincroniza para empezar'}
            </Text>
          )}
        </View>

        {historial.length > 0 && (
          <View style={s.tablaCard}>
            <Text style={s.chartTitulo}>Últimas lecturas guardadas</Text>
            <View style={s.tablaHeader}>
              <Text style={[s.celda, s.celdaHeader]}>Hora</Text>
              <Text style={[s.celda, s.celdaHeader]}>DHT °C</Text>
              <Text style={[s.celda, s.celdaHeader]}>Hum %</Text>
              <Text style={[s.celda, s.celdaHeader]}>LM35 °C</Text>
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

        <TouchableOpacity
          style={[s.boton, cargando && s.botonDeshabilitado]}
          onPress={sincronizar}
          disabled={cargando}
        >
          {cargando
            ? <ActivityIndicator color="#fff" />
            : <Text style={s.botonTexto}>Sincronizar con ESP32</Text>
          }
        </TouchableOpacity>

        <Text style={s.nota}>Los datos se guardan automáticamente en Supabase al sincronizar</Text>

      </ScrollView>
    </SafeAreaView>
  );
}

function TarjetaValor({ etiqueta, valor, color }) {
  return (
    <View style={s.tarjeta}>
      <Text style={s.tarjetaEtiqueta}>{etiqueta}</Text>
      <Text style={[s.tarjetaValor, { color }]}>{valor}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  container:          { flex: 1, backgroundColor: '#f5f7fb' },
  scroll:             { padding: 16, alignItems: 'center', paddingBottom: 40 },
  titulo:             { fontSize: 26, fontWeight: 'bold', color: '#1a1a1a', marginTop: 12, textAlign: 'center' },
  subtitulo:          { fontSize: 13, color: '#888', marginBottom: 20, textAlign: 'center' },
  fila:               { flexDirection: 'row', gap: 10, width: '100%', marginBottom: 16 },
  tarjeta:            { flex: 1, backgroundColor: '#fff', borderRadius: 14, padding: 14, alignItems: 'center',
                        shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 6, elevation: 3 },
  tarjetaEtiqueta:    { fontSize: 10, fontWeight: '700', color: '#aaa', letterSpacing: 1, marginBottom: 6 },
  tarjetaValor:       { fontSize: 22, fontWeight: 'bold' },
  errorBox:           { width: '100%', backgroundColor: '#fff3f3', borderRadius: 10, padding: 12, marginBottom: 12,
                        borderLeftWidth: 3, borderLeftColor: '#E8593C' },
  errorText:          { color: '#c0392b', fontSize: 13 },
  chartCard:          { width: '100%', backgroundColor: '#fff', borderRadius: 16, padding: 16,
                        shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 6, elevation: 3, marginBottom: 16 },
  chartHeader:        { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  chartTitulo:        { fontSize: 15, fontWeight: '600', color: '#333' },
  refrescarBtn:       { fontSize: 13, color: '#007AFF' },
  sinDatos:           { color: '#aaa', fontSize: 13, textAlign: 'center', paddingVertical: 30 },
  tablaCard:          { width: '100%', backgroundColor: '#fff', borderRadius: 16, padding: 16,
                        shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 6, elevation: 3, marginBottom: 20 },
  tablaHeader:        { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#eee', paddingBottom: 6, marginBottom: 4, marginTop: 10 },
  tablaFila:          { flexDirection: 'row', paddingVertical: 5 },
  filaImpar:          { backgroundColor: '#fafafa' },
  celda:              { flex: 1, fontSize: 12, color: '#555', textAlign: 'center' },
  celdaHeader:        { fontWeight: '700', color: '#888', fontSize: 11 },
  boton:              { width: '100%', height: 54, backgroundColor: '#007AFF', borderRadius: 14,
                        justifyContent: 'center', alignItems: 'center',
                        shadowColor: '#007AFF', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.25, shadowRadius: 8, elevation: 5 },
  botonDeshabilitado: { backgroundColor: '#a0c7ff' },
  botonTexto:         { color: '#fff', fontSize: 16, fontWeight: 'bold' },
  nota:               { marginTop: 14, fontSize: 12, color: '#aaa', textAlign: 'center' },
});