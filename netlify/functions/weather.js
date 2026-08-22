// Hourly weather for Baan OuadChum's location (Pathio, Chumphon). weather.com's
// hourly page (the source the site originally pointed at) loads its data via a
// client-side JS API call rather than server-rendered HTML, so it can't be scraped
// the same way the RoomScope calendar is. Open-Meteo provides the same kind of
// hourly forecast for the same coordinates via a free, keyless, stable JSON API.
const LATITUDE = 10.70908;
const LONGITUDE = 99.3182;

const HOURLY_FIELDS = [
  'temperature_2m',
  'apparent_temperature',
  'precipitation_probability',
  'weathercode',
  'relative_humidity_2m',
  'wind_speed_10m',
  'is_day'
].join(',');

const CURRENT_FIELDS = [
  'temperature_2m',
  'apparent_temperature',
  'weathercode',
  'relative_humidity_2m',
  'wind_speed_10m',
  'is_day'
].join(',');

const DAILY_FIELDS = [
  'weathercode',
  'temperature_2m_max',
  'temperature_2m_min',
  'precipitation_probability_max'
].join(',');

exports.handler = async () => {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${LATITUDE}&longitude=${LONGITUDE}` +
    `&hourly=${HOURLY_FIELDS}&current=${CURRENT_FIELDS}&daily=${DAILY_FIELDS}` +
    `&timezone=Asia%2FBangkok&forecast_days=7`;

  try {
    const upstream = await fetch(url);
    if (!upstream.ok) throw new Error(`Open-Meteo responded ${upstream.status}`);
    const raw = await upstream.json();

    // raw.current.time carries minutes (e.g. "...T14:15") but raw.hourly.time only
    // has on-the-hour entries ("...T14:00"), so match on the truncated hour.
    const currentHourIso = raw.current.time.slice(0, 13) + ':00';
    const startIdx = raw.hourly.time.indexOf(currentHourIso);
    const from = startIdx === -1 ? 0 : startIdx;
    const hours = raw.hourly.time.slice(from, from + 24).map((time, i) => ({
      time,
      temperature: Math.round(raw.hourly.temperature_2m[from + i]),
      feelsLike: Math.round(raw.hourly.apparent_temperature[from + i]),
      precipitationProbability: raw.hourly.precipitation_probability[from + i],
      weatherCode: raw.hourly.weathercode[from + i],
      humidity: raw.hourly.relative_humidity_2m[from + i],
      windSpeed: Math.round(raw.hourly.wind_speed_10m[from + i]),
      isDay: raw.hourly.is_day[from + i] === 1
    }));

    const days = raw.daily.time.map((date, i) => ({
      date,
      weatherCode: raw.daily.weathercode[i],
      tempMax: Math.round(raw.daily.temperature_2m_max[i]),
      tempMin: Math.round(raw.daily.temperature_2m_min[i]),
      precipitationProbability: raw.daily.precipitation_probability_max[i]
    }));

    const body = {
      location: { name: 'Pathio, Chumphon', latitude: raw.latitude, longitude: raw.longitude },
      current: {
        time: raw.current.time,
        temperature: Math.round(raw.current.temperature_2m),
        feelsLike: Math.round(raw.current.apparent_temperature),
        weatherCode: raw.current.weathercode,
        humidity: raw.current.relative_humidity_2m,
        windSpeed: Math.round(raw.current.wind_speed_10m),
        isDay: raw.current.is_day === 1
      },
      hours,
      days
    };

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=900, stale-while-revalidate=3600'
      },
      body: JSON.stringify(body)
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message || 'Failed to reach weather service' })
    };
  }
};
