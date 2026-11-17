const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const AMADEUS_BASE_URL = (process.env.AMADEUS_BASE_URL || 'https://test.api.amadeus.com').replace(/\/$/, '');
const AMADEUS_CLIENT_ID = process.env.AMADEUS_CLIENT_ID;
const AMADEUS_CLIENT_SECRET = process.env.AMADEUS_CLIENT_SECRET;
const MAX_HOTELS = 8;
let tokenCache = { value: null, expiresAt: 0 };

function send(res, status, body, extraHeaders = {}) {
  const payload = body === null ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders
  });
  res.end(payload);
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function integerParam(value, fallback, min, max, label) {
  const number = value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    const error = new Error(`${label} must be between ${min} and ${max}.`);
    error.status = 400;
    throw error;
  }
  return number;
}

async function getAmadeusToken() {
  if (!AMADEUS_CLIENT_ID || !AMADEUS_CLIENT_SECRET) {
    const error = new Error('Travel search is not configured yet. The site owner needs to add Amadeus credentials to the server.');
    error.status = 503;
    throw error;
  }
  if (tokenCache.value && tokenCache.expiresAt > Date.now() + 30000) return tokenCache.value;

  const response = await fetch(`${AMADEUS_BASE_URL}/v1/security/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: AMADEUS_CLIENT_ID,
      client_secret: AMADEUS_CLIENT_SECRET
    }),
    signal: AbortSignal.timeout(15000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.access_token) {
    const error = new Error('Could not sign in to the travel provider. Please try again later.');
    error.status = 502;
    throw error;
  }
  tokenCache = {
    value: result.access_token,
    expiresAt: Date.now() + Number(result.expires_in || 1800) * 1000
  };
  return tokenCache.value;
}

async function amadeus(pathname, params = {}) {
  const token = await getAmadeusToken();
  const url = new URL(`${AMADEUS_BASE_URL}${pathname}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  });
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    signal: AbortSignal.timeout(20000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const providerDetail = result.errors?.[0]?.detail;
    const error = new Error(providerDetail || 'The travel provider could not return results for that search.');
    error.status = 502;
    throw error;
  }
  return result;
}

async function findLocationCode(value, type) {
  const text = String(value || '').trim();
  if (!text) {
    const error = new Error(type === 'airport' ? 'Enter a departure and arrival airport code.' : 'Enter a destination city or 3-letter city code.');
    error.status = 400;
    throw error;
  }
  if (/^[A-Za-z]{3}$/.test(text)) return text.toUpperCase();
  const result = type === 'airport'
    ? await amadeus('/v1/reference-data/locations', { keyword: text, subType: 'AIRPORT', 'page[limit]': 5 })
    : await amadeus('/v1/reference-data/locations/cities', { keyword: text, max: 5 });
  const first = (result.data || []).find(item => item.iataCode);
  if (!first) {
    const error = new Error(`No matching ${type} was found. Try a 3-letter IATA code.`);
    error.status = 404;
    throw error;
  }
  return first.iataCode;
}

function normalizeFlight(offer) {
  return {
    id: offer.id || null,
    price: offer.price?.grandTotal || offer.price?.total || null,
    currency: offer.price?.currency || null,
    itineraries: (offer.itineraries || []).map(itinerary => ({
      duration: itinerary.duration || null,
      segments: (itinerary.segments || []).map(segment => ({
        airline: segment.carrierCode || null,
        flightNumber: segment.number || null,
        from: segment.departure?.iataCode || null,
        departureAt: segment.departure?.at || null,
        to: segment.arrival?.iataCode || null,
        arrivalAt: segment.arrival?.at || null,
        duration: segment.duration || null,
        stops: Number(segment.numberOfStops || 0)
      }))
    }))
  };
}

async function searchFlights(url) {
  const originInput = url.searchParams.get('origin');
  const destinationInput = url.searchParams.get('destination');
  const departureDate = url.searchParams.get('departureDate');
  const returnDate = url.searchParams.get('returnDate');
  if (!departureDate || !validDate(departureDate)) {
    const error = new Error('Choose a valid flight departure date.'); error.status = 400; throw error;
  }
  if (returnDate && (!validDate(returnDate) || returnDate < departureDate)) {
    const error = new Error('Return date must be on or after departure.'); error.status = 400; throw error;
  }
  const adults = integerParam(url.searchParams.get('adults'), 1, 1, 9, 'Adults');
  const children = integerParam(url.searchParams.get('children'), 0, 0, 9, 'Children');
  const infants = integerParam(url.searchParams.get('infants'), 0, 0, 9, 'Infants');
  if (adults + children + infants > 9) {
    const error = new Error('The total number of passengers cannot exceed 9.'); error.status = 400; throw error;
  }
  const travelClass = (url.searchParams.get('travelClass') || 'ECONOMY').toUpperCase();
  if (!['ECONOMY', 'PREMIUM_ECONOMY', 'BUSINESS', 'FIRST'].includes(travelClass)) {
    const error = new Error('Choose a valid cabin class.'); error.status = 400; throw error;
  }
  const [origin, destination] = await Promise.all([
    findLocationCode(originInput, 'airport'),
    findLocationCode(destinationInput, 'airport')
  ]);
  const result = await amadeus('/v2/shopping/flight-offers', {
    originLocationCode: origin,
    destinationLocationCode: destination,
    departureDate,
    returnDate,
    adults,
    children,
    infants,
    travelClass,
    max: 10
  });
  return (result.data || []).map(normalizeFlight);
}

async function searchHotels(url) {
  const cityInput = url.searchParams.get('city');
  const checkInDate = url.searchParams.get('checkInDate');
  const checkOutDate = url.searchParams.get('checkOutDate');
  if (!checkInDate || !checkOutDate || !validDate(checkInDate) || !validDate(checkOutDate) || checkOutDate <= checkInDate) {
    const error = new Error('Choose valid check-in and check-out dates. Check-out must be after check-in.'); error.status = 400; throw error;
  }
  const adults = integerParam(url.searchParams.get('adults'), 1, 1, 9, 'Adults');
  const rooms = integerParam(url.searchParams.get('rooms'), 1, 1, 9, 'Rooms');
  const cityCode = await findLocationCode(cityInput, 'city');
  const listing = await amadeus('/v1/reference-data/locations/hotels/by-city', {
    cityCode,
    hotelSource: 'ALL'
  });
  const hotels = (listing.data || []).slice(0, MAX_HOTELS);
  if (!hotels.length) return [];

  const responses = await Promise.all(hotels.map(async hotel => {
    try {
      const search = await amadeus('/v3/shopping/hotel-offers', {
        hotelIds: hotel.hotelId,
        adults,
        roomQuantity: rooms,
        checkInDate,
        checkOutDate
      });
      const item = (search.data || []).find(row => row.hotel?.hotelId === hotel.hotelId) || search.data?.[0];
      const offer = item?.offers?.[0];
      if (!offer) return null;
      return {
        hotelId: item.hotel?.hotelId || hotel.hotelId || null,
        name: item.hotel?.name || hotel.name || null,
        address: item.hotel?.address || hotel.address || null,
        rating: item.hotel?.rating || hotel.rating || null,
        price: offer.price?.total || null,
        currency: offer.price?.currency || null,
        roomType: offer.room?.typeEstimated?.category || offer.room?.type || null,
        cancellation: offer.policies?.cancellations?.[0]?.description?.text || null,
        bookingLink: offer.self || null
      };
    } catch (error) {
      // A property without an available offer is omitted; no price is synthesized.
      return null;
    }
  }));
  return responses.filter(Boolean);
}

async function exchangeToEur(amount, currency) {
  const value = Number(amount);
  const code = String(currency || '').toUpperCase();
  if (!Number.isFinite(value) || !code) return { amount: null, currency: code || null, eur: null, approximate: true };
  if (code === 'EUR') return { amount: value, currency: code, eur: value, approximate: false };
  try {
    const response = await fetch(`https://api.frankfurter.app/latest?from=${encodeURIComponent(code)}&to=EUR`, { signal: AbortSignal.timeout(12000) });
    const result = await response.json();
    const rate = result.rates?.EUR;
    if (!response.ok || !Number.isFinite(rate)) throw new Error('Exchange rate unavailable');
    return { amount: value, currency: code, eur: value * rate, approximate: true, rateDate: result.date || null };
  } catch {
    return { amount: value, currency: code, eur: null, approximate: true, rateDate: null };
  }
}

async function addCurrencyConversions(offers) {
  return Promise.all(offers.map(async offer => ({
    ...offer,
    eurConversion: offer.price && offer.currency ? await exchangeToEur(offer.price, offer.currency) : null
  })));
}

async function weatherForStay(url) {
  const city = String(url.searchParams.get('city') || '').trim();
  const startDate = url.searchParams.get('startDate');
  const endDate = url.searchParams.get('endDate');
  if (!city || !startDate || !endDate || !validDate(startDate) || !validDate(endDate) || endDate < startDate) {
    const error = new Error('Enter a destination and valid stay dates to check weather.'); error.status = 400; throw error;
  }
  const geocodeUrl = new URL('https://geocoding-api.open-meteo.com/v1/search');
  geocodeUrl.search = new URLSearchParams({ name: city, count: '1', language: 'en', format: 'json' });
  const geoResponse = await fetch(geocodeUrl, { signal: AbortSignal.timeout(12000) });
  const geo = await geoResponse.json();
  const location = geo.results?.[0];
  if (!location) return { available: false, message: 'Weather location not found.', daily: [] };

  const weatherUrl = new URL('https://api.open-meteo.com/v1/forecast');
  weatherUrl.search = new URLSearchParams({
    latitude: String(location.latitude),
    longitude: String(location.longitude),
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code',
    timezone: 'auto',
    start_date: startDate,
    end_date: endDate
  });
  const response = await fetch(weatherUrl, { signal: AbortSignal.timeout(15000) });
  const weather = await response.json().catch(() => ({}));
  if (!response.ok || !weather.daily?.time) {
    return { available: false, message: 'A forecast is unavailable for those dates. No historical or estimated weather is substituted.', daily: [] };
  }
  return {
    available: true,
    location: `${location.name}${location.country ? `, ${location.country}` : ''}`,
    daily: weather.daily.time.map((date, index) => ({
      date,
      maxC: weather.daily.temperature_2m_max?.[index] ?? null,
      minC: weather.daily.temperature_2m_min?.[index] ?? null,
      precipitationProbability: weather.daily.precipitation_probability_max?.[index] ?? null,
      weatherCode: weather.daily.weather_code?.[index] ?? null
    }))
  };
}

function serveStatic(req, res, url) {
  let requested = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const normalized = path.normalize(requested).replace(/^([/\\])+/, '');
  const root = path.resolve(__dirname);
  const filename = path.resolve(root, normalized);
  if (!filename.startsWith(root + path.sep) && filename !== root) return send(res, 403, { error: 'Forbidden.' });
  fs.readFile(filename, (error, contents) => {
    if (error) return send(res, 404, { error: 'File not found.' });
    const type = filename.endsWith('.html') ? 'text/html; charset=utf-8'
      : filename.endsWith('.css') ? 'text/css; charset=utf-8'
      : filename.endsWith('.js') ? 'text/javascript; charset=utf-8'
      : filename.endsWith('.webmanifest') ? 'application/manifest+json'
      : 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'x-content-type-options': 'nosniff' });
    res.end(contents);
  });
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
  catch { return send(res, 400, { error: 'Invalid request URL.' }); }

  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed.' });
    return serveStatic(req, res, url);
  }
  if (req.method === 'OPTIONS') return send(res, 204, null);
  if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed.' });

  try {
    if (url.pathname === '/api/health') {
      return send(res, 200, {
        ok: true,
        providers: ['Amadeus', 'Frankfurter', 'Open-Meteo'],
        environment: AMADEUS_BASE_URL.includes('test.') ? 'test' : 'production',
        credentialsConfigured: Boolean(AMADEUS_CLIENT_ID && AMADEUS_CLIENT_SECRET)
      });
    }
    if (url.pathname === '/api/flights') {
      const offers = await searchFlights(url);
      return send(res, 200, {
        provider: 'Amadeus',
        environment: AMADEUS_BASE_URL.includes('test.') ? 'test' : 'production',
        fetchedAt: new Date().toISOString(),
        offers: await addCurrencyConversions(offers),
        message: offers.length ? null : 'No flight offers were returned by the provider.'
      });
    }
    if (url.pathname === '/api/hotels') {
      const offers = await searchHotels(url);
      return send(res, 200, {
        provider: 'Amadeus',
        environment: AMADEUS_BASE_URL.includes('test.') ? 'test' : 'production',
        fetchedAt: new Date().toISOString(),
        offers: await addCurrencyConversions(offers),
        message: offers.length ? null : 'No priced hotel offers were returned by the provider.'
      });
    }
    if (url.pathname === '/api/weather') {
      const data = await weatherForStay(url);
      return send(res, 200, { provider: 'Open-Meteo', fetchedAt: new Date().toISOString(), ...data });
    }
    if (url.pathname === '/api/currency') {
      const amount = url.searchParams.get('amount');
      const currency = url.searchParams.get('currency');
      if (amount === null || !Number.isFinite(Number(amount)) || Number(amount) < 0 || !/^[A-Za-z]{3}$/.test(currency || '')) {
        return send(res, 400, { error: 'Provide a non-negative amount and a 3-letter currency code.' });
      }
      const conversion = await exchangeToEur(amount, currency);
      return send(res, 200, { provider: 'Frankfurter', fetchedAt: new Date().toISOString(), ...conversion });
    }
    return send(res, 404, { error: 'API route not found.' });
  } catch (error) {
    return send(res, error.status || 502, {
      error: error.message || 'Provider data is currently unavailable.',
      provider: url.pathname === '/api/weather' ? 'Open-Meteo' : url.pathname === '/api/currency' ? 'Frankfurter' : 'Amadeus',
      fetchedAt: new Date().toISOString()
    });
  }
});

server.listen(PORT, HOST, () => console.log(`Roamly is running at http://localhost:${PORT}`));
