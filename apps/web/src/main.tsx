import React from 'react'
import ReactDOM from 'react-dom/client'
import 'dsh-tavern-renderer/styles'
import './styles.css'
import { App } from './App.js'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>,
)
