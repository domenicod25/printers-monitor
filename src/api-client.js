/**
 * API Client - Comunicazione con Backend
 * 
 * Gestisce tutte le richieste HTTP al backend con:
 * - Headers automatici (api_key, tenant_id)
 * - Retry logic
 * - Error handling
 */

const axios = require('axios');

class APIClient {
  constructor(config) {
    this.baseURL = config.backend_url;
    this.apiKey = config.api_key;
    this.tenantId = config.tenant_id;
    this.retryAttempts = config.retry_attempts || 3;
    this.retryDelay = config.retry_delay || 5000;
  }

  /**
   * Esegue una richiesta HTTP con retry logic
   */
  async request(endpoint, options = {}) {
    const url = `${this.baseURL}${endpoint}`;
    
    const config = {
      method: options.method || 'GET',
      url: url,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'x-tenant-id': this.tenantId,
        ...options.headers,
      },
      data: options.body,
      timeout: 30000,
      validateStatus: () => true, // Non lanciare errore per status code
    };

    for (let attempt = 1; attempt <= this.retryAttempts; attempt++) {
      try {
        const response = await axios(config);
        
        if (response.status >= 400) {
          throw new Error(`HTTP ${response.status}: ${response.statusText || 'Error'}`);
        }

        return response.data;
      } catch (error) {
        console.error(`❌ Request failed (attempt ${attempt}/${this.retryAttempts}):`, error.message);
        
        if (attempt < this.retryAttempts) {
          console.log(`   Retrying in ${this.retryDelay/1000}s...`);
          await new Promise(resolve => setTimeout(resolve, this.retryDelay));
        } else {
          throw error;
        }
      }
    }
  }

  /**
   * GET request
   */
  get(endpoint, options = {}) {
    return this.request(endpoint, { ...options, method: 'GET' });
  }

  /**
   * POST request
   */
  post(endpoint, data, options = {}) {
    return this.request(endpoint, {
      ...options,
      method: 'POST',
      body: data, // axios gestisce automaticamente JSON.stringify
    });
  }

  /**
   * PUT request
   */
  put(endpoint, data, options = {}) {
    return this.request(endpoint, {
      ...options,
      method: 'PUT',
      body: data, // axios gestisce automaticamente JSON.stringify
    });
  }

  /**
   * DELETE request
   */
  delete(endpoint, options = {}) {
    return this.request(endpoint, { ...options, method: 'DELETE' });
  }
}

module.exports = APIClient;
