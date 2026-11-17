const http = require('node:http');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT || 3000);
const AMADEUS_BASE_URL = (process.env.AMADEUS_BASE_URL || 'https://test.api.amadeus.com').replace(/\/$/, '');
const AMADEUS_CLIENT_ID = process.env.AMADEUS_CLIENT_ID;
const AMADEUS_CLIENT_SECRET = process.env.AMADEUS_CLIENT_SECRET;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'http://localhost:3000';
const WEATHER_BASE = 'https://api.open-meteo.com/v1';
const EXCHANGE_BASE = 'https://api.frankfurter.app';
let tokenCache = { value: null, expiresAt: 0 };

function send(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': ALLOWED_ORIGIN,
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'content-type'
  });
  res.end(JSON.stringify(body));
}

function isValidDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || '') && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

async function getAmadeusToken() {
  if (!AMADEUS_CLIENT_ID || !AMADEUS_CLIENT_SECRET) {
    const error = new Error('Amadeus credentials are not configured on the server. Add AMADEUS_CLIENT_ID and AMADEUS_CLIENT_SECRET before live searches.');
    error.status = 503;
    throw error;
  }

  if (tokenCache.value && tokenCache.expiresAt > Date.now() + 30000) return tokenCache.value;

  const response = await fetch(`${AMADEUS_BASE_URL}/v1/security/oauth2/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: AMADEUS_CLIENT_ID,
      client_secret: AMADEUS_CLIENT_SECRET
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    const error = new Error('Authentication with the provider failed. Check the server credentials.');
    error.status = 502;
    throw error;
  }

  tokenCache = {
    value: payload.access_token,
    expiresAt: Date.now() + Number(payload.expires_in || 1800) * 1000
  };

  return tokenCache.value;
}

async function amadeusFetch(path, query = {}, method = 'GET') {
  const token = await getAmadeusToken();
  const url = new URL(`${AMADEUS_BASE_URL}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json'
    }
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error('Provider search failed. Check the request parameters and credentials.');
    error.status = 502;
    throw error;
  }

  return payload;
}

async function resolveLocationCode(keyword, type) {
  const safeKeyword = encodeURIComponent((keyword || '').trim());
  if (!safeKeyword) throw new Error('A location name is required.');

  if (type === 'airport') {
    const result = await amadeusFetch('/v1/reference-data/locations', {
      keyword: keyword.trim(),
      subType: 'AIRPORT',
      page[limit]: 5
    });
    const first = (result.data || []).find(item => item.iataCode);
    if (!first) throw new Error('No airport codes were found for that location.');
    return first.iataCode;
  }

  const result = await amadeusFetch('/v1/reference-data/locations/cities', {
    keyword: keyword.trim(),
    max: 5
  });
  const first = (result.data || []).find(item => item.iataCode);
  if (!first) throw new Error('No city code was found for that destination.');
  return first.iataCode;
}

async function searchFlights({ origin, destination, departureDate, returnDate, adults = 1, travelClass = 'ECONOMY' }) {
  const originCode = /^[A-Z]{3}$/.test(String(origin || '').toUpperCase())
    ? String(origin).toUpperCase()
    : await resolveLocationCode(String(origin || ''), 'airport');

  const destinationCode = /^[A-Z]{3}$/.test(String(destination || '').toUpperCase())
    ? String(destination).toUpperCase()
    : await resolveLocationCode(String(destination || ''), 'airport');

  const payload = await amadeusFetch('/v2/shopping/flight-offers', {
    originLocationCode: originCode,
    destinationLocationCode: destinationCode,
    departureDate,
    returnDate,
    adults,
    travelClass,
    max: 10
  }, 'POST');

  return (payload.data || []).map(offer => ({
    id: offer.id,
    source: 'Amadeus',
    price: offer.price?.grandTotal || offer.price?.total || null,
    currency: offer.price?.currency || 'USD',
    offersCount: Array.isArray(offer.itineraries) ? offer.itineraries.length : 0,
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
        layover: segment.numberOfStops || 0
      }))
    }))
  }));
}

async function searchHotels({ cityCode, checkInDate, checkOutDate, adults = 2, rooms = 1 }) {
  const resolvedCityCode = /^[A-Z]{3}$/.test(String(cityCode || '').toUpperCase())
    ? String(cityCode).toUpperCase()
    : await resolveLocationCode(String(cityCode || ''), 'city');

  const cityListing = await amadeusFetch('/v1/reference-data/locations/hotels/by-city', {
    cityCode: resolvedCityCode,
    hotelSource: 'ALL',
    radius: 50,
    radiusUnit: 'KM'
  });

  const hotels = (cityListing.data || []).slice(0, 12);
  if (!hotels.length) return [];

  const hotelOffers = await Promise.all(hotels.map(async hotel => {
    try {
      const response = await amadeusFetch('/v3/shopping/hotel-offers', {
        hotelIds: hotel.hotelId,
        adults,
        roomQuantity: rooms,
        checkInDate,
        checkOutDate
      });
      const item = (response.data || []).find(entry => entry.hotel?.hotelId === hotel.hotelId) || (response.data || [])[0];
      const offer = item?.offers?.[0];
      if (!offer) return null;
      return {
        source: 'Amadeus',
        hotelId: item.hotel?.hotelId || hotel.hotelId || null,
        hotelName: item.hotel?.name || hotel.name || null,
        address: item.hotel?.address || hotel.address || null,
        rating: item.hotel?.rating || hotel.rating || null,
        price: offer.price?.total || null,
        currency: offer.price?.currency || 'USD',
        roomType: offer.room?.typeEstimated?.category || offer.room?.type || null,
        cancellation: offer.policies?.cancellations?.[0]?.description?.text || null,
        bookingLink: offer.self || null
      };
    } catch {
      return null;
    }
  }));

  return hotelOffers.filter(Boolean);
}

async function convertToEur(amount, currency) {
  if (!amount || !currency) return { localCurrency: currency || 'USD', value: Number(amount || 0), eur: 0, source: 'not-converted' };
  const target = String(currency).toUpperCase();
  if (target === 'EUR') {
    return { localCurrency: target, value: Number(amount || 0), eur: Number(amount || 0), source: 'direct' };
  }
  const response = await fetch(`${EXCHANGE_BASE}/latest?from=${encodeURIComponent(target)}&to=EUR`);
  const payload = await response.json().catch(() => ({}));
  const rate = payload.rates?.EUR || null;
  if (!rate) {
    return { localCurrency: target, value: Number(amount || 0), eur: null, source: 'unavailable' };
  }
  return {
    localCurrency: target,
    value: Number(amount || 0),
    eur: Number(amount || 0) * Number(rate),
    source: 'frankfurter'
  };
}

async function weatherForLocation({ city, startDate, endDate }) {
  const query = encodeURIComponent(String(city || '').trim());
  if (!query) return { source: 'Open-Meteo', error: 'Location is required for weather.' };

  const geocodeRes = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${query}&count=1&language=en&format=json`);
  const geocode = await geocodeRes.json().catch(() => ({}));
  const result = geocode.results?.[0];
  if (!result) return { source: 'Open-Meteo', error: 'No weather location matched that destination.' };

  const start = startDate || new Date().toISOString().slice(0, 10);
  const end = endDate || start;
  const weatherRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${result.latitude}&longitude=${result.longitude}&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code&timezone=auto&start_date=${start}&end_date=${end}`);
  const weather = await weatherRes.json().catch(() => ({}));

  return {
    source: 'Open-Meteo',
    location: result.name,
    country: result.country,
    daily: (weather.daily?.time || []).map((date, index) => ({
      date,
      max: weather.daily.temperature_2m_max?.[index] ?? null,
      min: weather.daily.temperature_2m_min?.[index] ?? null,
      precipitationChance: weather.daily.precipitation_probability_max?.[index] ?? null,
      conditionCode: weather.daily.weather_code?.[index] ?? null
    }))
  };
}

function safeJson(value) {
  return value === undefined ? null : value;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    return send(res, 204, {});
  }

  if (req.method !== 'GET') return send(res, 405, { error: 'Only GET requests are supported for public search data.' });

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/api/health') {
    return send(res, 200, {
      ok: true,
      provider: 'Amadeus + Open-Meteo + Frankfurter',
      environment: AMADEUS_BASE_URL.includes('test.') ? 'test' : 'production'
    });
  }

  try {
    if (url.pathname === '/api/flights') {
      const origin = url.searchParams.get('origin');
      const destination = url.searchParams.get('destination');
      const departureDate = url.searchParams.get('departureDate');
      const returnDate = url.searchParams.get('returnDate');
      if (!origin || !destination || !departureDate || !isValidDate(departureDate)) {
        return send(res, 400, { error: 'origin, destination, and departureDate are required. Use YYYY-MM-DD.' });
      }
      const adults = Number(url.searchParams.get('adults') || 1);
      const travelClass = (url.searchParams.get('travelClass') || 'ECONOMY').toUpperCase();
      const offers = await searchFlights({ origin, destination, departureDate, returnDate, adults, travelClass });
      const withCurrencies = await Promise.all(offers.map(async item => ({
        ...item,
        converted: item.price ? await convertToEur(item.price, item.currency) : null
      })));
      return send(res, 200, {
        provider: 'Amadeus',
        fetchedAt: new Date().toISOString(),
        offers: withCurrencies,
        total: withCurrencies.length
      });
    }

    if (url.pathname === '/api/hotels') {
      const cityCode = url.searchParams.get('cityCode');
      const checkInDate = url.searchParams.get('checkInDate');
      const checkOutDate = url.searchParams.get('checkOutDate');
      if (!cityCode || !checkInDate || !checkOutDate || !isValidDate(checkInDate) || !isValidDate(checkOutDate)) {
        return send(res, 400, { error: 'cityCode, checkInDate, and checkOutDate are required. Use YYYY-MM-DD.' });
      }
      const adults = Number(url.searchParams.get('adults') || 2);
      const rooms = Number(url.searchParams.get('rooms') || 1);
      const offers = await searchHotels({ cityCode, checkInDate, checkOutDate, adults, rooms });
      const withCurrencies = await Promise.all(offers.map(async item => ({
        ...item,
        converted: item.price ? await convertToEur(item.price, item.currency) : null
      })));
      return send(res, 200, {
        provider: 'Amadeus',
        fetchedAt: new Date().toISOString(),
        offers: withCurrencies,
        total: withCurrencies.length
      });
    }

    if (url.pathname === '/api/weather') {
      const city = url.searchParams.get('city');
      const startDate = url.searchParams.get('startDate');
      const endDate = url.searchParams.get('endDate');
      if (!city) return send(res, 400, { error: 'city is required.' });
      const data = await weatherForLocation({ city, startDate, endDate });
      return send(res, 200, { provider: 'Open-Meteo', fetchedAt: new Date().toISOString(), data });
    }

    if (url.pathname === '/api/currency') {
      const amount = Number(url.searchParams.get('amount') || 0);
      const currency = (url.searchParams.get('currency') || 'USD').toUpperCase();
      const result = await convertToEur(amount, currency);
      return send(res, 200, { provider: 'Frankfurter', fetchedAt: new Date().toISOString(), ...result });
    }

    return send(res, 404, { error: 'Route not found.' });
  } catch (error) {
    const status = error.status || 500;
    return send(res, status, {
      error: error.message || 'Travel data is currently unavailable.',
      provider: 'Amadeus/Open-Meteo',
      fetchedAt: new Date().toISOString()
    });
  }
});

server.listen(PORT, () => {
  console.log(`Roamly API is running on http://localhost:${PORT}`);
});

