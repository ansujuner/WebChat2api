// This must be the FIRST import in the main entry point: Axios instances copy
// defaults when constructed by imported adapters/forwarders.
import axios from 'axios'
import { chromiumAxiosAdapter } from './transport'

axios.defaults.adapter = chromiumAxiosAdapter
