/**
 * Knosys Weather Plugin — v2.1.0
 *
 * Self-contained weather forecasts and saved-location management.
 *
 * Owns:
 *   - Locations list (CRUD + home flag), persisted to
 *     `vault/PluginData/knosys-weather/locations.json` via api.vault.
 *   - Per-location weather data fetched from OpenWeather's One Call 3.0
 *     API via api.network.fetch (CORS-bypassed through the host).
 *   - Daily weather log cache at
 *     `vault/PluginData/knosys-weather/logs/{YYYY-MM-DD}.json`. A 15-minute
 *     freshness window short-circuits redundant API calls.
 *
 * Does NOT depend on:
 *   - AppDataContext (the host context the v2.0.0 plugin read from).
 *   - Any host IPC channels for locations / weather logs / current
 *     position; everything routes through the plugin API v2.1 surface.
 */

// =============================================================================
// Plugin types — kept verbatim against the host's PluginAPI v2.1 shape so the
// plugin builds without a published @knosys/plugin-types package.
// =============================================================================

type PluginPermission =
  | 'storage'
  | 'network'
  | 'location'
  | 'filesystem'
  | 'core:locations'
  | 'core:notes'
  | 'core:reminders'
  | 'core:calendar'
  | 'vault:read'
  | 'vault:write'
  | 'sqlite:read'
  | 'sqlite:write'

interface PluginVaultListEntry { name: string; isDirectory: boolean; size: number }

interface PluginAPI {
  pluginId: string
  pluginVersion: string
  permissions: PluginPermission[]
  hasPermission: (permission: PluginPermission) => boolean
  storage: {
    get: <T>(key: string) => Promise<T | null>
    set: <T>(key: string, value: T) => Promise<void>
    delete: (key: string) => Promise<void>
    clear: () => Promise<void>
    keys: () => Promise<string[]>
  }
  core: {
    getLocations: () => Promise<Array<{
      id: string
      name: string
      slug: string
      coordinates: { lat: number; lon: number }
      isHome: boolean
    }>>
    getVaultPath: () => Promise<string>
    getApiKey: (keyId: string) => Promise<string | null>
  }
  network: {
    fetch: (
      url: string,
      init?: {
        method?: 'GET' | 'POST' | 'HEAD'
        headers?: Record<string, string>
        body?: ArrayBuffer | string
        timeoutMs?: number
      },
    ) => Promise<{
      status: number
      statusText: string
      headers: Record<string, string>
      body: ArrayBuffer
    }>
  }
  ui: {
    registerRoute: (route: { path: string; component: any }) => void
    registerSidebarItem: (item: { id: string; title: string; icon: string; route: string; order: number }) => void
    registerWidget: (widget: { id: string; title: string; component: any; defaultSize: 'small' | 'medium' | 'large' }) => void
    registerSettingsPanel: (panel: { id: string; component: any; title?: string; order?: number }) => void
    toast: (toast: { message: string; type?: 'info' | 'success' | 'error' | 'warning'; duration?: number }) => void
  }
  vault: {
    readFile: (relPath: string) => Promise<string>
    readFileBytes: (relPath: string) => Promise<ArrayBuffer>
    writeFile: (relPath: string, contents: string | ArrayBuffer) => Promise<void>
    deleteFile: (relPath: string) => Promise<void>
    listFiles: (relPath?: string) => Promise<PluginVaultListEntry[]>
    exists: (relPath: string) => Promise<boolean>
  }
  log: {
    debug: (...args: unknown[]) => void
    info: (...args: unknown[]) => void
    warn: (...args: unknown[]) => void
    error: (...args: unknown[]) => void
  }
}

interface SharedDependencies {
  React: typeof import('react')
  useNavigate: () => any
  kdl: Record<string, any>
  shadcn: Record<string, any>
  lucideIcons: Record<string, any>
  useState: typeof import('react').useState
  useEffect: typeof import('react').useEffect
  useCallback: typeof import('react').useCallback
  useMemo: typeof import('react').useMemo
  useRef: typeof import('react').useRef
  cn: (...args: any[]) => string
}

// =============================================================================
// Module state — populated at activate(). All UI components read through here.
// =============================================================================

let api: PluginAPI
let shared: SharedDependencies

// =============================================================================
// Domain types
// =============================================================================

interface SavedLocation {
  id: string
  name: string
  slug: string
  coordinates: { lat: number; lon: number }
  isHome: boolean
  country?: string
}

interface CurrentLocation {
  name: string
  coordinates: { lat: number; lon: number }
  country?: string
}

interface HourlyForecast {
  dt: number
  temp: number
  pop: number
  weather: Array<{ id: number; main: string; description: string; icon: string }>
}

interface DailyForecast {
  dt: number
  temp: { min: number; max: number; day: number; night: number; eve: number; morn: number }
  pop: number
  weather: Array<{ id: number; main: string; description: string; icon: string }>
}

interface WeatherData {
  location: string
  country: string
  coordinates: { lat: number; lon: number }
  temperature: number
  feelsLike: number
  tempMin: number
  tempMax: number
  description: string
  icon: string
  pressure: number
  humidity: number
  visibility: string
  dewPoint: number
  uvi: number
  windSpeed: number
  windDirection: string
  windGust?: number
  sunrise: string
  sunset: string
  hourlyForecast: HourlyForecast[]
  dailyForecast: DailyForecast[]
  lastUpdated: string
  timezone: string
}

interface WeatherSettingsValues {
  refreshIntervalMinutes: number
  temperatureUnit: 'fahrenheit' | 'celsius'
}

const DEFAULT_SETTINGS: WeatherSettingsValues = {
  refreshIntervalMinutes: 30,
  temperatureUnit: 'fahrenheit',
}

// =============================================================================
// Constants
// =============================================================================

const OPENWEATHER_ONECALL_URL = 'https://api.openweathermap.org/data/3.0/onecall'
const OPENWEATHER_GEOCODING_URL = 'https://api.openweathermap.org/geo/1.0'
const GOOGLE_MAPS_GEOCODING_URL = 'https://maps.googleapis.com/maps/api/geocode/json'
const TIMEZONE_LOOKUP_URL = 'https://timeapi.io/api/TimeZone/coordinate'

const LOCATIONS_VAULT_PATH = 'locations.json'
const LOG_CACHE_MAX_AGE_MS = 15 * 60 * 1000 // 15 minutes

// =============================================================================
// Utility helpers
// =============================================================================

function createSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function generateId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function todayDateKey(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function getWindDirection(deg: number): string {
  const directions = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
  return directions[Math.round(deg / 22.5) % 16]
}

function formatVisibility(meters: number): string {
  if (meters >= 10000) return '10+ miles'
  return `${(meters * 0.000621371).toFixed(1)} mi`
}

function formatTime(timestamp: number, timezoneName: string | null, offsetSec: number): string {
  if (timezoneName) {
    try {
      return new Date(timestamp * 1000).toLocaleTimeString('en-US', {
        timeZone: timezoneName,
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      })
    } catch {
      // fall through to offset form
    }
  }
  const date = new Date((timestamp + offsetSec) * 1000)
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
}

function formatTimezone(timezoneName: string | null, offsetSec: number): string {
  if (timezoneName) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezoneName, timeZoneName: 'short' }).formatToParts(new Date())
      const tz = parts.find((p) => p.type === 'timeZoneName')
      if (tz) return tz.value
    } catch {
      // ignore
    }
    const parts = timezoneName.split('/')
    return parts[parts.length - 1].replace(/_/g, ' ')
  }
  const hours = Math.floor(Math.abs(offsetSec) / 3600)
  const minutes = Math.floor((Math.abs(offsetSec) % 3600) / 60)
  return `UTC${offsetSec >= 0 ? '+' : '-'}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

// =============================================================================
// Network helpers — api.network.fetch is CORS-bypassed through the host main
// process. Body comes back as ArrayBuffer; decode here for JSON convenience.
// =============================================================================

async function fetchJson<T = unknown>(url: string): Promise<T | null> {
  try {
    const res = await api.network.fetch(url)
    if (res.status < 200 || res.status >= 300) {
      api.log.warn(`[fetchJson] ${url} → HTTP ${res.status}`)
      return null
    }
    const text = new TextDecoder().decode(res.body)
    return JSON.parse(text) as T
  } catch (err) {
    api.log.warn(`[fetchJson] ${url} failed:`, err)
    return null
  }
}

async function getTimezoneName(lat: number, lon: number): Promise<string | null> {
  const data = await fetchJson<{ timeZone?: string }>(`${TIMEZONE_LOOKUP_URL}?latitude=${lat}&longitude=${lon}`)
  return data?.timeZone ?? null
}

// =============================================================================
// Geocoding (forward + reverse) — Google Maps preferred, OpenWeather fallback
// =============================================================================

interface GeocodeResult {
  name: string
  coordinates: { lat: number; lon: number }
  country: string
}

async function reverseGeocodeViaGoogle(lat: number, lon: number, apiKey: string): Promise<{ name: string; country: string } | null> {
  const data = await fetchJson<any>(`${GOOGLE_MAPS_GEOCODING_URL}?latlng=${lat},${lon}&key=${encodeURIComponent(apiKey)}`)
  if (!data || data.status !== 'OK' || !Array.isArray(data.results) || data.results.length === 0) return null
  const result = data.results[0]
  const components = (result.address_components ?? []) as Array<{ types: string[]; short_name: string; long_name: string }>
  const countryComp = components.find((c) => c.types.includes('country'))
  const localityComp = components.find((c) => c.types.includes('locality'))
  const adminComp = components.find((c) => c.types.includes('administrative_area_level_1'))
  let name = result.formatted_address || `${lat.toFixed(2)}, ${lon.toFixed(2)}`
  if (localityComp && adminComp) name = `${localityComp.long_name}, ${adminComp.short_name}`
  else if (localityComp) name = localityComp.long_name
  else if (adminComp) name = adminComp.long_name
  return { name, country: countryComp?.short_name ?? countryComp?.long_name ?? '' }
}

async function reverseGeocodeViaOpenWeather(lat: number, lon: number, apiKey: string): Promise<{ name: string; country: string } | null> {
  const data = await fetchJson<any[]>(`${OPENWEATHER_GEOCODING_URL}/reverse?lat=${lat}&lon=${lon}&limit=1&appid=${encodeURIComponent(apiKey)}`)
  if (!data || data.length === 0) return null
  const result = data[0]
  let name = result.name || `${lat.toFixed(2)}, ${lon.toFixed(2)}`
  if (result.state && result.name !== result.state) name = `${result.name}, ${result.state}`
  return { name, country: result.country ?? '' }
}

async function reverseGeocode(lat: number, lon: number): Promise<{ name: string; country: string }> {
  const googleKey = await api.core.getApiKey('google_maps')
  if (googleKey) {
    const g = await reverseGeocodeViaGoogle(lat, lon, googleKey)
    if (g) return g
  }
  const owKey = await api.core.getApiKey('openweather')
  if (owKey) {
    const o = await reverseGeocodeViaOpenWeather(lat, lon, owKey)
    if (o) return o
  }
  return { name: `${lat.toFixed(2)}, ${lon.toFixed(2)}`, country: '' }
}

async function forwardGeocode(query: string): Promise<GeocodeResult | null> {
  const apiKey = await api.core.getApiKey('openweather')
  if (!apiKey) {
    api.log.warn('forwardGeocode: openweather API key not configured')
    return null
  }
  const trimmed = query.trim()
  const isZip = /^\d{5}(-\d{4})?$/.test(trimmed)
  const url = isZip
    ? `${OPENWEATHER_GEOCODING_URL}/zip?zip=${encodeURIComponent(trimmed)},US&appid=${encodeURIComponent(apiKey)}`
    : `${OPENWEATHER_GEOCODING_URL}/direct?q=${encodeURIComponent(trimmed)}&limit=1&appid=${encodeURIComponent(apiKey)}`
  const data = await fetchJson<any>(url)
  const result = Array.isArray(data) ? data[0] : data
  if (!result?.lat || !result?.lon) return null
  let name = result.name || trimmed
  if (result.state && result.name !== result.state) name = `${result.name}, ${result.state}`
  if (result.country && result.country !== 'US') name = `${name}, ${result.country}`
  return { name, coordinates: { lat: result.lat, lon: result.lon }, country: result.country ?? '' }
}

// =============================================================================
// Weather log cache — daily JSON files in plugin's vault sandbox.
// Schema: { [logKey]: { fetchedAt: ISO, current, hourly, daily } } so multiple
// locations share a file. 15-minute freshness threshold.
// =============================================================================

type LogEntry = { fetchedAt: string; current: any; hourly: any[]; daily: any[] }

async function readDailyLog(): Promise<Record<string, LogEntry>> {
  const path = `logs/${todayDateKey()}.json`
  if (!(await api.vault.exists(path))) return {}
  try {
    const text = await api.vault.readFile(path)
    const parsed = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch (err) {
    api.log.warn('readDailyLog: failed to parse cache, ignoring', err)
    return {}
  }
}

async function writeDailyLog(map: Record<string, LogEntry>): Promise<void> {
  const path = `logs/${todayDateKey()}.json`
  try {
    await api.vault.writeFile(path, JSON.stringify(map, null, 2))
  } catch (err) {
    api.log.warn('writeDailyLog: failed', err)
  }
}

async function getCachedWeatherSnapshot(logKey: string): Promise<LogEntry | null> {
  const log = await readDailyLog()
  const entry = log[logKey]
  if (!entry) return null
  const age = Date.now() - new Date(entry.fetchedAt).getTime()
  return age <= LOG_CACHE_MAX_AGE_MS ? entry : null
}

async function setCachedWeatherSnapshot(logKey: string, snapshot: Omit<LogEntry, 'fetchedAt'>): Promise<void> {
  const log = await readDailyLog()
  log[logKey] = { fetchedAt: new Date().toISOString(), ...snapshot }
  await writeDailyLog(log)
}

// =============================================================================
// One Call API — fetch + process into WeatherData
// =============================================================================

function processWeatherData(oneCall: any, locationName: string, country: string, coords: { lat: number; lon: number }, tzName: string | null): WeatherData {
  const current = oneCall.current
  const offsetSec = oneCall.timezone_offset || 0
  const today = oneCall.daily?.[0]
  return {
    location: locationName,
    country,
    coordinates: coords,
    temperature: Math.round(current.temp),
    feelsLike: Math.round(current.feels_like),
    tempMin: today ? Math.round(today.temp.min) : Math.round(current.temp),
    tempMax: today ? Math.round(today.temp.max) : Math.round(current.temp),
    description: current.weather[0].description,
    icon: current.weather[0].icon,
    pressure: current.pressure,
    humidity: current.humidity,
    visibility: formatVisibility(current.visibility || 10000),
    dewPoint: Math.round(current.dew_point),
    uvi: Math.round(current.uvi * 10) / 10,
    windSpeed: Math.round(current.wind_speed * 10) / 10,
    windDirection: getWindDirection(current.wind_deg || 0),
    windGust: current.wind_gust ? Math.round(current.wind_gust * 10) / 10 : undefined,
    sunrise: formatTime(current.sunrise, tzName, offsetSec),
    sunset: formatTime(current.sunset, tzName, offsetSec),
    hourlyForecast: oneCall.hourly || [],
    dailyForecast: oneCall.daily || [],
    lastUpdated: formatTime(current.dt, tzName, offsetSec),
    timezone: formatTimezone(tzName, offsetSec),
  }
}

async function fetchWeather(lat: number, lon: number, logKey: string): Promise<WeatherData | null> {
  const cached = await getCachedWeatherSnapshot(logKey)
  if (cached) {
    api.log.debug(`Using cached weather (logKey=${logKey}, age<15min)`)
    const [tzName, locationInfo] = await Promise.all([getTimezoneName(lat, lon), reverseGeocode(lat, lon)])
    return processWeatherData(
      { current: cached.current, hourly: cached.hourly, daily: cached.daily, timezone_offset: 0 },
      locationInfo.name,
      locationInfo.country,
      { lat, lon },
      tzName,
    )
  }

  const apiKey = await api.core.getApiKey('openweather')
  if (!apiKey) {
    api.log.warn('fetchWeather: openweather API key not configured')
    return null
  }

  const [oneCall, tzName, locationInfo] = await Promise.all([
    fetchJson<any>(`${OPENWEATHER_ONECALL_URL}?lat=${lat}&lon=${lon}&units=imperial&exclude=minutely,alerts&appid=${encodeURIComponent(apiKey)}`),
    getTimezoneName(lat, lon),
    reverseGeocode(lat, lon),
  ])
  if (!oneCall) return null

  await setCachedWeatherSnapshot(logKey, {
    current: oneCall.current,
    hourly: oneCall.hourly,
    daily: oneCall.daily,
  })

  return processWeatherData(oneCall, locationInfo.name, locationInfo.country, { lat, lon }, tzName)
}

// =============================================================================
// Locations store — load/save to vault, plus React hook for components
// =============================================================================

async function readLocationsFromVault(): Promise<SavedLocation[]> {
  if (!(await api.vault.exists(LOCATIONS_VAULT_PATH))) return []
  try {
    const text = await api.vault.readFile(LOCATIONS_VAULT_PATH)
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? (parsed as SavedLocation[]) : []
  } catch (err) {
    api.log.warn('readLocationsFromVault: failed', err)
    return []
  }
}

async function writeLocationsToVault(locations: SavedLocation[]): Promise<void> {
  await api.vault.writeFile(LOCATIONS_VAULT_PATH, JSON.stringify(locations, null, 2))
  locationsBus.dispatchEvent(new Event('changed'))
}

// Module-level event bus so multiple useLocationsStore() instances stay in
// sync. WeatherPage + LocationManagerPanel each mount their own hook; without
// this, adding a location in Settings wouldn't show on the Weather page until
// remount. Plain EventTarget — no extra deps.
const locationsBus = new EventTarget()

function useLocationsStore() {
  const { useState, useEffect, useCallback } = shared
  const [locations, setLocations] = useState<SavedLocation[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = () => {
      readLocationsFromVault().then((entries) => {
        if (cancelled) return
        setLocations(entries)
        setLoaded(true)
      })
    }
    load()
    const onChange = () => load()
    locationsBus.addEventListener('changed', onChange)
    return () => {
      cancelled = true
      locationsBus.removeEventListener('changed', onChange)
    }
  }, [])

  const persist = useCallback(async (next: SavedLocation[]) => {
    setLocations(next)
    try {
      await writeLocationsToVault(next)
    } catch (err) {
      api.log.error('persist locations failed', err)
    }
  }, [])

  const addLocation = useCallback(async (input: GeocodeResult): Promise<SavedLocation> => {
    const baseSlug = createSlug(input.name) || 'location'
    let slug = baseSlug
    let n = 2
    const existingSlugs = new Set(locations.map((l) => l.slug))
    while (existingSlugs.has(slug)) {
      slug = `${baseSlug}-${n++}`
    }
    const entry: SavedLocation = {
      id: generateId(),
      name: input.name,
      slug,
      coordinates: input.coordinates,
      isHome: locations.length === 0, // first location is home by default
      country: input.country || undefined,
    }
    await persist([...locations, entry])
    return entry
  }, [locations, persist])

  const deleteLocation = useCallback(async (id: string) => {
    const wasHome = locations.find((l) => l.id === id)?.isHome ?? false
    const next = locations.filter((l) => l.id !== id)
    if (wasHome && next.length > 0) next[0].isHome = true
    await persist(next)
  }, [locations, persist])

  const setHome = useCallback(async (id: string) => {
    await persist(locations.map((l) => ({ ...l, isHome: l.id === id })))
  }, [locations, persist])

  const homeLocation = locations.find((l) => l.isHome) ?? null

  return { locations, loaded, homeLocation, addLocation, deleteLocation, setHome, refresh: () => readLocationsFromVault().then(setLocations) }
}

// =============================================================================
// Current-location hook — browser geolocation, single-shot per mount
// =============================================================================

function useCurrentLocation(enabled: boolean) {
  const { useState, useEffect } = shared
  const [position, setPosition] = useState<CurrentLocation | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled) return
    if (!navigator.geolocation) {
      setError('Geolocation not supported by this browser')
      return
    }
    setLoading(true)
    navigator.geolocation.getCurrentPosition(
      async (geo) => {
        const lat = geo.coords.latitude
        const lon = geo.coords.longitude
        const info = await reverseGeocode(lat, lon)
        setPosition({ name: info.name, coordinates: { lat, lon }, country: info.country })
        setLoading(false)
      },
      (err) => {
        setError(err.message || 'Failed to get location')
        setLoading(false)
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
    )
  }, [enabled])

  return { position, loading, error }
}

// =============================================================================
// Settings store — refresh interval + temperature unit, via api.storage
// =============================================================================

function useSettings() {
  const { useState, useEffect, useCallback } = shared
  const [settings, setSettings] = useState<WeatherSettingsValues>(DEFAULT_SETTINGS)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    Promise.all([
      api.storage.get<number>('refreshIntervalMinutes'),
      api.storage.get<'fahrenheit' | 'celsius'>('temperatureUnit'),
    ]).then(([interval, unit]) => {
      setSettings({
        refreshIntervalMinutes: interval ?? DEFAULT_SETTINGS.refreshIntervalMinutes,
        temperatureUnit: unit ?? DEFAULT_SETTINGS.temperatureUnit,
      })
      setLoaded(true)
    })
  }, [])

  const update = useCallback(async <K extends keyof WeatherSettingsValues>(key: K, value: WeatherSettingsValues[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }))
    await api.storage.set(key, value)
  }, [])

  return { settings, loaded, update }
}

// =============================================================================
// UI: forecast pieces
// =============================================================================

function getWeatherIcon(iconCode: string | undefined) {
  const { Cloud, CloudRain, Sun, CloudSun } = shared.lucideIcons
  if (!iconCode) return Cloud
  if (iconCode.includes('01')) return Sun
  if (iconCode.includes('02')) return CloudSun
  if (iconCode.includes('03') || iconCode.includes('04')) return Cloud
  if (iconCode.includes('09') || iconCode.includes('10')) return CloudRain
  return Cloud
}

function formatHourLabel(timestamp: number, index: number): string {
  if (index === 0) return 'Now'
  return new Date(timestamp * 1000).toLocaleTimeString('en-US', { hour: 'numeric', hour12: true })
}

function formatDayLabel(timestamp: number): string {
  const d = new Date(timestamp * 1000)
  const today = new Date()
  const tomorrow = new Date(today)
  tomorrow.setDate(tomorrow.getDate() + 1)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === tomorrow.toDateString()) return 'Tomorrow'
  return d.toLocaleDateString('en-US', { weekday: 'short' })
}

function HourlyRail({ data, loading }: { data: HourlyForecast[]; loading: boolean }) {
  const { Card, CardContent, CardHeader } = shared.kdl
  return (
    <Card className="p-4">
      <CardHeader className="p-0 pb-4">
        <h3 className="text-sm font-medium text-muted-foreground">HOURLY FORECAST</h3>
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <div className="flex gap-4 animate-pulse">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="flex-shrink-0 w-20 h-32 bg-muted rounded-lg" />
            ))}
          </div>
        ) : data.length > 0 ? (
          <div className="w-full overflow-x-auto pb-4">
            <div className="flex gap-4 min-w-max">
              {data.map((hour, index) => {
                const Icon = getWeatherIcon(hour.weather?.[0]?.icon)
                return (
                  <div key={hour.dt} className="flex-shrink-0 w-20 flex flex-col items-center gap-2">
                    <div className="text-sm text-muted-foreground">{formatHourLabel(hour.dt, index)}</div>
                    <Icon className="h-8 w-8" />
                    {hour.pop > 0 && <div className="text-xs text-blue-400">{Math.round(hour.pop * 100)}%</div>}
                    <div className="text-lg font-semibold">{Math.round(hour.temp)}°</div>
                  </div>
                )
              })}
            </div>
          </div>
        ) : (
          <div className="p-8 text-center text-muted-foreground">No hourly forecast data available</div>
        )}
      </CardContent>
    </Card>
  )
}

function DailyList({ data, loading }: { data: DailyForecast[]; loading: boolean }) {
  const { Card, CardContent, CardHeader } = shared.kdl
  return (
    <Card className="p-4">
      <CardHeader className="p-0 pb-4">
        <h3 className="text-sm font-medium text-muted-foreground">8-DAY FORECAST</h3>
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-12 bg-muted rounded-lg animate-pulse" />
            ))}
          </div>
        ) : data.length > 0 ? (
          <div className="space-y-2">
            {data.map((day) => {
              const Icon = getWeatherIcon(day.weather?.[0]?.icon)
              return (
                <div key={day.dt} className="flex items-center justify-between p-3 rounded-lg hover:bg-accent/50 transition-colors">
                  <div className="w-24 text-sm font-medium">{formatDayLabel(day.dt)}</div>
                  <Icon className="h-6 w-6" />
                  <div className="text-xs text-blue-400 w-12 text-right">{day.pop > 0 ? `${Math.round(day.pop * 100)}%` : ''}</div>
                  <div className="flex items-center gap-3 text-sm">
                    <span className="font-semibold">{Math.round(day.temp.max)}°</span>
                    <span className="text-muted-foreground">{Math.round(day.temp.min)}°</span>
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="p-8 text-center text-muted-foreground">No daily forecast data available</div>
        )}
      </CardContent>
    </Card>
  )
}

function StatWidgets({ weather }: { weather: WeatherData }) {
  const { Card, CardContent, CardHeader } = shared.kdl
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      <Card>
        <CardHeader><h3 className="text-sm font-medium text-muted-foreground">WIND</h3></CardHeader>
        <CardContent>
          <div className="text-2xl font-semibold">{weather.windSpeed} mph</div>
          {weather.windGust && <div className="text-sm text-muted-foreground">Gusts: {weather.windGust} mph</div>}
          <div className="text-sm text-muted-foreground">{weather.windDirection}</div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><h3 className="text-sm font-medium text-muted-foreground">HUMIDITY</h3></CardHeader>
        <CardContent>
          <div className="text-3xl font-semibold">{weather.humidity}%</div>
          <div className="text-sm text-muted-foreground">The dew point is {weather.dewPoint}° right now.</div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><h3 className="text-sm font-medium text-muted-foreground">VISIBILITY</h3></CardHeader>
        <CardContent>
          <div className="text-3xl font-semibold">{weather.visibility}</div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><h3 className="text-sm font-medium text-muted-foreground">PRESSURE</h3></CardHeader>
        <CardContent>
          <div className="text-2xl font-semibold">{(weather.pressure * 0.02953).toFixed(2)} inHg</div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><h3 className="text-sm font-medium text-muted-foreground">UV INDEX</h3></CardHeader>
        <CardContent>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-semibold">{Math.round(weather.uvi)}</span>
            <span className="text-sm text-muted-foreground">
              {weather.uvi <= 2 ? 'Low' : weather.uvi <= 5 ? 'Moderate' : weather.uvi <= 7 ? 'High' : 'Very High'}
            </span>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><h3 className="text-sm font-medium text-muted-foreground">SUNRISE / SUNSET</h3></CardHeader>
        <CardContent>
          <div className="text-2xl font-semibold">{weather.sunrise}</div>
          <div className="text-sm text-muted-foreground">Sunset: {weather.sunset}</div>
        </CardContent>
      </Card>
    </div>
  )
}

// =============================================================================
// Main weather page — location selector + forecast
// =============================================================================

function WeatherPage() {
  const { useState, useEffect, useMemo } = shared
  const { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Button } = shared.kdl
  const { Home, Navigation, RefreshCw } = shared.lucideIcons

  const locStore = useLocationsStore()
  const [selectedId, setSelectedId] = useState<string>('current-location')
  const { position, loading: locating, error: locationError } = useCurrentLocation(selectedId === 'current-location')

  // Default the selection to home when locations load
  useEffect(() => {
    if (!locStore.loaded) return
    if (selectedId === 'current-location') return
    if (locStore.locations.find((l) => l.id === selectedId)) return
    if (locStore.homeLocation) setSelectedId(locStore.homeLocation.id)
  }, [locStore.loaded, locStore.locations, locStore.homeLocation?.id])

  const selectedLocation: { name: string; coordinates: { lat: number; lon: number }; logKey: string; isHome?: boolean; isCurrent?: boolean } | null = useMemo(() => {
    if (selectedId === 'current-location') {
      if (!position) return null
      return { name: position.name, coordinates: position.coordinates, logKey: 'currentLocation', isCurrent: true }
    }
    const loc = locStore.locations.find((l) => l.id === selectedId)
    if (!loc) return null
    return { name: loc.name, coordinates: loc.coordinates, logKey: loc.name, isHome: loc.isHome }
  }, [selectedId, locStore.locations, position?.name, position?.coordinates.lat, position?.coordinates.lon])

  const [weather, setWeather] = useState<WeatherData | null>(null)
  const [weatherLoading, setWeatherLoading] = useState(false)
  const [weatherError, setWeatherError] = useState<string | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)

  useEffect(() => {
    if (!selectedLocation) {
      setWeather(null)
      return
    }
    let cancelled = false
    setWeatherLoading(true)
    setWeatherError(null)
    fetchWeather(selectedLocation.coordinates.lat, selectedLocation.coordinates.lon, selectedLocation.logKey)
      .then((data) => {
        if (cancelled) return
        if (!data) setWeatherError('Could not fetch weather. Check that your OpenWeather API key is configured.')
        setWeather(data)
        setWeatherLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setWeatherError(String(err?.message ?? err))
        setWeatherLoading(false)
      })
    return () => { cancelled = true }
  }, [selectedLocation?.coordinates.lat, selectedLocation?.coordinates.lon, selectedLocation?.logKey, refreshTick])

  // Periodic background refresh per settings
  const { settings } = useSettings()
  useEffect(() => {
    if (!selectedLocation) return
    const id = setInterval(() => setRefreshTick((t) => t + 1), Math.max(1, settings.refreshIntervalMinutes) * 60 * 1000)
    return () => clearInterval(id)
  }, [settings.refreshIntervalMinutes, selectedLocation?.logKey])

  const hourly = useMemo(() => {
    if (!weather?.hourlyForecast) return []
    const now = Date.now() / 1000
    return weather.hourlyForecast.filter((h) => h.dt >= now).slice(0, 24)
  }, [weather])

  const daily = useMemo(() => weather?.dailyForecast?.slice(0, 8) ?? [], [weather])

  const noLocations = locStore.loaded && locStore.locations.length === 0
  const showCurrentLocationOption = selectedId === 'current-location' || locStore.locations.length === 0

  return (
    <div className="flex-1 min-h-screen bg-background p-8">
      <div className="mx-auto space-y-8 max-w-6xl">
        {/* Top bar: location picker + refresh */}
        <div className="flex items-center justify-between gap-2">
          <Select value={selectedId} onValueChange={(v: string) => setSelectedId(v)}>
            <SelectTrigger className="w-72">
              <SelectValue placeholder="Select a location" />
            </SelectTrigger>
            <SelectContent>
              {showCurrentLocationOption && (
                <SelectItem value="current-location">📍 Current location</SelectItem>
              )}
              {locStore.locations.map((loc) => (
                <SelectItem key={loc.id} value={loc.id}>
                  {loc.isHome ? '🏠 ' : ''}
                  {loc.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={() => setRefreshTick((t) => t + 1)} disabled={weatherLoading}>
            <RefreshCw className={shared.cn('h-4 w-4 mr-2', weatherLoading && 'animate-spin')} />
            Refresh
          </Button>
        </div>

        {noLocations && !position && !locating && (
          <div className="text-center py-16 text-muted-foreground">
            <p>No saved locations yet.</p>
            <p className="mt-2 text-sm">Add one from Settings → Plugins → Weather → Saved Locations, or allow location access for current weather.</p>
          </div>
        )}

        {(weatherError || locationError) && (
          <div className="text-center text-destructive p-4">{weatherError || locationError}</div>
        )}

        {selectedLocation && (
          <div className="text-center mb-8">
            <div className="flex items-center justify-center gap-2 mb-2">
              {selectedLocation.isCurrent ? <Navigation className="h-5 w-5 text-muted-foreground" /> : selectedLocation.isHome ? <Home className="h-5 w-5 text-muted-foreground" /> : null}
              <h2 className="text-3xl font-semibold">{selectedLocation.name}</h2>
            </div>
            {weather && (
              <>
                <div className="text-6xl font-light mb-2">{weather.temperature}°</div>
                <div className="text-xl text-muted-foreground capitalize mb-2">{weather.description}</div>
                <div className="text-lg text-muted-foreground">H:{weather.tempMax}° L:{weather.tempMin}°</div>
              </>
            )}
          </div>
        )}

        <HourlyRail data={hourly} loading={weatherLoading && !weather} />
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          <div className="lg:col-span-4"><DailyList data={daily} loading={weatherLoading && !weather} /></div>
          <div className="lg:col-span-8">{weather && <StatWidgets weather={weather} />}</div>
        </div>
      </div>
    </div>
  )
}

// =============================================================================
// Settings panel — refresh interval + temperature unit
// =============================================================================

function WeatherSettingsPanel() {
  const { Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } = shared.kdl
  const { settings, loaded, update } = useSettings()
  if (!loaded) return <div className="text-sm text-muted-foreground">Loading settings…</div>
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Label className="text-sm">Refresh interval</Label>
        <Select value={String(settings.refreshIntervalMinutes)} onValueChange={(v: string) => update('refreshIntervalMinutes', Number(v))}>
          <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="15">15 minutes</SelectItem>
            <SelectItem value="30">30 minutes</SelectItem>
            <SelectItem value="60">1 hour</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center justify-between">
        <Label className="text-sm">Temperature unit</Label>
        <Select value={settings.temperatureUnit} onValueChange={(v: string) => update('temperatureUnit', v as 'fahrenheit' | 'celsius')}>
          <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="fahrenheit">Fahrenheit</SelectItem>
            <SelectItem value="celsius">Celsius</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}

// =============================================================================
// Settings panel — saved locations (add/delete/setHome)
// =============================================================================

function LocationManagerPanel() {
  const { useState } = shared
  const { Button, Input, Card, CardContent } = shared.kdl
  const { Home, MapPin, Trash2, Star } = shared.lucideIcons
  const store = useLocationsStore()
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onAdd = async () => {
    const q = query.trim()
    if (!q) return
    setBusy(true); setError(null)
    try {
      const result = await forwardGeocode(q)
      if (!result) {
        setError(`No results for "${q}". Try a more specific query, or check your OpenWeather API key.`)
        return
      }
      await store.addLocation(result)
      setQuery('')
      api.ui.toast({ message: `Added ${result.name}`, type: 'success' })
    } catch (err) {
      setError(String((err as Error)?.message ?? err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <Input
          placeholder="City, state or zip code"
          value={query}
          onChange={(e: any) => setQuery(e.target.value)}
          onKeyDown={(e: any) => { if (e.key === 'Enter') onAdd() }}
          disabled={busy}
        />
        <Button onClick={onAdd} disabled={busy || !query.trim()}>
          {busy ? 'Adding…' : 'Add'}
        </Button>
      </div>
      {error && <div className="text-sm text-destructive">{error}</div>}
      {store.loaded && store.locations.length === 0 && (
        <div className="text-sm text-muted-foreground">No saved locations yet.</div>
      )}
      <div className="space-y-2">
        {store.locations.map((loc) => (
          <Card key={loc.id}>
            <CardContent className="p-3 flex items-center gap-3">
              {loc.isHome ? <Home className="h-4 w-4 text-primary" /> : <MapPin className="h-4 w-4 text-muted-foreground" />}
              <div className="flex-1">
                <div className="font-medium">{loc.name}</div>
                <div className="text-xs text-muted-foreground">
                  {loc.coordinates.lat.toFixed(3)}, {loc.coordinates.lon.toFixed(3)}
                  {loc.country ? ` · ${loc.country}` : ''}
                </div>
              </div>
              {!loc.isHome && (
                <Button variant="ghost" size="sm" onClick={() => store.setHome(loc.id)} title="Set as home">
                  <Star className="h-4 w-4" />
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={() => store.deleteLocation(loc.id)} title="Delete">
                <Trash2 className="h-4 w-4" />
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}

// =============================================================================
// Plugin lifecycle
// =============================================================================

export function activate(pluginApi: PluginAPI, sharedDeps: SharedDependencies) {
  api = pluginApi
  shared = sharedDeps
  api.log.info('Activating Weather plugin v2.1.0…')

  api.ui.registerSidebarItem({ id: 'weather', title: 'Weather', icon: 'Cloud', route: '/weather', order: 30 })
  api.ui.registerRoute({ path: '/weather', component: WeatherPage })
  api.ui.registerSettingsPanel({ id: 'weather-locations', component: LocationManagerPanel, title: 'Saved locations', order: 5 })
  api.ui.registerSettingsPanel({ id: 'weather-settings', component: WeatherSettingsPanel, title: 'Preferences', order: 10 })

  api.log.info('Weather plugin activated')
}

export function deactivate() {
  api?.log.info('Weather plugin deactivated')
}
