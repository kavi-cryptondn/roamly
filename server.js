const http = require('node:http');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT || 3000);
const AMADEUS_BASE_URL = (process.env.AMADEUS_BASE_URL || 'https://test.api.amadeus.com').replace(/\/$/, '');
const AMADEUS_CLIENT_ID = process.env.AMADEUS_CLIENT_ID;
const AMADEUS_CLIENT_SECRET = process.env.AMADEUS_CLIENT_SECRET;
let tokenCache = { value: null, expiresAt: 0 };

function send(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': process.env.ALLOWED_ORIGIN || 'http://localhost:3000',
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'content-type'
  });
  res.end(JSON.stringify(body));
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || '') && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

async function getToken() {
  if (!AMADEUS_CLIENT_ID || !AMADEUS_CLIENT_SECRET) {
    const error = new Error('Amadeus API credentials are not configured on the server.');
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
    })
  });
  const payload = await response.json();
  if (!response.ok || !payload.access_token) {
    const error = new Error('Could not authenticate with the travel provider.');
    error.status = 502;
    throw error;
  }
  tokenCache = { value: payload.access_token, expiresAt: Date.now() + Number(payload.expires_in || 0) * 1000 };
  return tokenCache.value;
}

async function amadeus(path, params, method = 'GET') {
  const token = await getToken();
  const url = new URL(`${AMADEUS_BASE_URL}${path}`);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, { method, headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error('The travel provider could not complete this search. Check the search details or try again.');
    error.status = response.status === 401 ? 502 : 502;
    throw error;
  }
  return payload;
}

function errorMessage(error) {
  if (error.status === 503) return { status: 503, message: error.message };
  return { status: error.status || 502, message: error.message || 'Travel data is temporarily unavailable.' };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed.' });
  if (url.pathname === '/api/health') return send(res, 200, { ok: true, provider: 'Amadeus', environment: AMADEUS_BASE_URL.includes('test.') ? 'test' : 'production' });

  try {
    if (url.pathname === '/api/flights') {
      const origin = (url.searchParams.get('origin') || '').toUpperCase();
      const destination = (url.searchParams.get('destination') || '').toUpperCase();
      const departureDate = url.searchParams.get('departureDate');
      const adults = Number(url.searchParams.get('adults') || 1);
      const children = Number(url.searchParams.get('children') || 0);
      const infants = Number(url.searchParams.get('infants') || 0);
      const travelClass = (url.searchParams.get('travelClass') || 'ECONOMY').toUpperCase();
      if (!/^[A-Z]{3}$/.test(origin) || !/^[A-Z]{3}$/.test(destination) || !validDate(departureDate)) {
        return send(res, 400, { error: 'Enter valid 3-letter airport codes and a departure date (YYYY-MM-DD).' });
      }
      if (![adults, children, infants].every(Number.isInteger) || adults < 1 || adults > 9 || children < 0 || infants < 0 || adults + children + infants > 9) {
        return send(res, 400, { error: 'Passenger count must be between 1 and 9, including at least one adult.' });
      }
      if (!['ECONOMY', 'PREMIUM_ECONOMY', 'BUSINESS', 'FIRST'].includes(travelClass)) return send(res, 400, { error: 'Choose a supported cabin class.' });
      const params = { originLocationCode: origin, destinationLocationCode: destination, departureDate, adults, children, infants, travelClass, max: 10 };
      const returnDate = url.searchParams.get('returnDate');
      if (returnDate) {
        if (!validDate(returnDate) || returnDate < departureDate) return send(res, 400, { error: 'Return date must be a valid date on or after departure.' });
        params.returnDate = returnDate;
      }
      const result = await amadeus('/v2/shopping/flight-offers', params);
      const offers = (result.data || []).map(offer => ({
        id: offer.id,
        price: offer.price?.grandTotal || offer.price?.total || null,
        currency: offer.price?.currency || null,
        itineraries: (offer.itineraries || []).map(itinerary => ({
          duration: itinerary.duration || null,
          segments: (itinerary.segments || []).map(segment => ({
            airline: segment.carrierCode || null,
            flightNumber: segment.number || null,
            from: segment.departure?.iataCode || null,
            departure: segment.departure?.at || null,
            to: segment.arrival?.iataCode || null,
            arrival: segment.arrival?.at || null,
            duration: segment.duration || null
          }))
        }))
      }));
      return send(res, 200, { provider: 'Amadeus', environment: AMADEUS_BASE_URL.includes('test.') ? 'test' : 'production', fetchedAt: new Date().toISOString(), offers, message: offers.length ? undefined : 'No offers were returned by the provider.' });
    }

    if (url.pathname === '/api/hotels') {
      const cityCode = (url.searchParams.get('cityCode') || '').toUpperCase();
      const checkInDate = url.searchParams.get('checkInDate');
      const checkOutDate = url.searchParams.get('checkOutDate');
      const adults = Number(url.searchParams.get('adults') || 1);
      const roomQuantity = Number(url.searchParams.get('rooms') || 1);
      if (!/^[A-Z]{3}$/.test(cityCode) || !validDate(checkInDate) || !validDate(checkOutDate) || checkOutDate <= checkInDate) {
        return send(res, 400, { error: 'Enter a 3-letter IATA city code and valid check-in/check-out dates.' });
      }
      if (!Number.isInteger(adults) || adults < 1 || adults > 9 || !Number.isInteger(roomQuantity) || roomQuantity < 1 || roomQuantity > 9) {
        return send(res, 400, { error: 'Adults and rooms must each be between 1 and 9.' });
      }
      const listing = await amadeus('/v1/reference-data/locations/hotels/by-city', { cityCode, hotelSource: 'ALL' });
      const hotels = (listing.data || []).slice(0, 20);
      if (!hotels.length) return send(res, 200, { provider: 'Amadeus', environment: AMADEUS_BASE_URL.includes('test.') ? 'test' : 'production', fetchedAt: new Date().toISOString(), offers: [], message: 'No hotels were returned by the provider for this city.' });
      const offersByHotel = await Promise.all(hotels.map(async hotel => {
        try {
          const response = await amadeus('/v3/shopping/hotel-offers', {
            hotelIds: hotel.hotelId, adults, roomQuantity, checkInDate, checkOutDate,
            currency: url.searchParams.get('currency') || undefined
          });
          const match = (response.data || []).find(item => item.hotel?.hotelId === hotel.hotelId) || response.data?.[0];
          const offer = match?.offers?.[0];
          if (!offer) return null;
          return {
            hotelId: hotel.hotelId,
            name: match.hotel?.name || hotel.name || null,
            location: match.hotel?.address || hotel.address || null,
            rating: match.hotel?.rating || null,
            price: offer.price?.total || null,
            currency: offer.price?.currency || null,
            roomType: offer.room?.typeEstimated?.category || offer.room?.type || null,
            cancellation: offer.policies?.cancellations?.[0]?.description?.text || null,
            bookingLink: offer.self || null
          };
        } catch { return null; }
      }));
      const offers = offersByHotel.filter(Boolean);
      return send(res, 200, { provider: 'Amadeus', environment: AMADEUS_BASE_URL.includes('test.') ? 'test' : 'production', fetchedAt: new Date().toISOString(), offers, message: offers.length ? undefined : 'No priced hotel offers were returned. Prices are not estimated.' });
    }

    return send(res, 404, { error: 'Not found.' });
  } catch (error) {
    const result = errorMessage(error);
    return send(res, result.status, { error: result.message });
  }
});

server.listen(PORT, () => console.log(`Roamly API listening on http://localhost:${PORT}`));
