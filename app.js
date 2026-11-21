(() => {
  const $ = id => document.getElementById(id);
  const fmtTime = s => {const h=Math.floor(s/3600),m=Math.floor(s%3600/60),sec=Math.floor(s%60);return h?`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`:`${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`};
  const fmtPace = speed => speed > 0.5 ? `${Math.floor(60/speed)}:${String(Math.round((60/speed%1)*60)%60).padStart(2,'0')}` : '—';
  const haversine = (a,b) => {const R=6371000,rad=x=>x*Math.PI/180,dLat=rad(b.lat-a.lat),dLon=rad(b.lng-a.lng),x=Math.sin(dLat/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dLon/2)**2;return 2*R*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));};
  let map, marker, track, watchId=null, timer=null, startedAt=0, elapsedBefore=0, paused=false, voiceOn=true, session=null, lastTerrainAt=0, altitudeWindow=[], wakeLock=null, wakeWanted=false, speedSamples=[], dropSince=0, lastDropAlert=0, awaitingRecovery=false, lastPraiseAt=0, lastBreathReminder=0, selectedEffort=null;
  let history = JSON.parse(localStorage.getItem('entrenamiento-history') || '[]');
  const defaultCenter=[-34.9214,-57.9544]; // La Plata, only initial map view; GPS centers on actual position.
  function initMap(){
    map=L.map('map',{zoomControl:false}).setView(defaultCenter,13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'}).addTo(map);
    L.control.zoom({position:'bottomleft'}).addTo(map);
    track=L.polyline([],{color:'#a879d5',weight:5,opacity:.95,lineCap:'round'}).addTo(map);
  }
  function toast(msg){const el=$('toast');el.textContent=msg;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),2800)}
  function say(msg){if(!voiceOn||!('speechSynthesis'in window))return;window.speechSynthesis.cancel();const u=new SpeechSynthesisUtterance(msg);u.lang='es-AR';u.rate=0.98;u.pitch=1.12;window.speechSynthesis.speak(u)}
  function setCoach(msg, speak=false){$('coachMessage').textContent=msg;if(speak)say(msg)}
  async function requestWakeLock(){
    if(!wakeWanted)return;
    if(!('wakeLock' in navigator)){
      $('wakeStatus').textContent='Safari no ofrece bloqueo de pantalla activo en esta sesión. Usá Ajustes > Pantalla y brillo > Bloqueo automático > Nunca.';
      $('wakeToggle').textContent='No disponible';
      $('wakeToggle').disabled=true;
      return;
    }
    try{
      wakeLock=await navigator.wakeLock.request('screen');
      $('wakeStatus').textContent='Pantalla activa solicitada. Mantené ENTRENAMIENTO visible durante la salida.';
      $('wakeToggle').textContent='☀ Activada';
      $('wakeToggle').classList.add('active');
      wakeLock.addEventListener('release',()=>{
        wakeLock=null;
        if(wakeWanted){
          $('wakeStatus').textContent='La pantalla liberó el bloqueo. Volvé a tocar Activar si seguís entrenando.';
          $('wakeToggle').textContent='☀ Reactivar';
          $('wakeToggle').classList.remove('active');
        }
      });
    }catch(err){
      $('wakeStatus').textContent='No se pudo mantener activa automáticamente. Configurá Bloqueo automático en Nunca.';
      $('wakeToggle').textContent='Revisar ajustes';
    }
  }
  async function releaseWakeLock(){
    if(wakeLock){try{await wakeLock.release()}catch(e){}wakeLock=null}
    $('wakeToggle').classList.remove('active');
    if(wakeWanted){
      $('wakeStatus').textContent='La pantalla se mantendrá activa durante la salida cuando esté habilitada.';
      $('wakeToggle').textContent='☀ Activar';
    }
  }

  function elapsed(){return elapsedBefore+(startedAt?Math.floor((Date.now()-startedAt)/1000):0)}
  function renderTime(){$('elapsed').textContent=fmtTime(elapsed())}
  function renderHistory(){
    const box=$('historyList');
    if(!history.length){box.innerHTML='<p class="empty-state">Todavía no hay salidas guardadas.</p>';return}
    box.innerHTML=history.slice(0,12).map((x,i)=>`<button class="history-item" data-index="${i}"><div><strong>${new Date(x.date).toLocaleDateString('es-AR',{day:'2-digit',month:'short',year:'numeric'})}</strong><span>${x.duration} · máxima ${Number(x.maxSpeed).toFixed(1)} km/h</span></div><div class="history-stats"><b>${Number(x.distance).toFixed(2)} km</b><small>prom. ${Number(x.avgSpeed).toFixed(1)} km/h</small></div></button>`).join('');
    box.querySelectorAll('[data-index]').forEach(btn=>btn.addEventListener('click',()=>showSavedRoute(Number(btn.dataset.index))));
  }
  function showSavedRoute(index){
    const item=history[index];if(!item||!item.points||!item.points.length){toast('Esta salida no tiene puntos de recorrido guardados.');return}
    if(session){toast('Finalizá la salida actual para consultar el historial.');return}
    track.setLatLngs(item.points.map(p=>[p.lat,p.lng]));
    const bounds=track.getBounds();if(bounds.isValid())map.fitBounds(bounds,{padding:[24,24]});
    $('mapHint').textContent='Recorrido guardado · '+new Date(item.date).toLocaleDateString('es-AR');
    toast('Mostrando el recorrido de esa salida.');
  }
  function setActive(active){$('gpsStatus').classList.toggle('active',active);$('gpsStatus').innerHTML=active?'<i></i> GPS ACTIVO':'<i></i> GPS INACTIVO'}
  function updateMetrics(){
    if(!session)return;
    const hours=Math.max(elapsed()/3600,1/3600),avg=session.distance/1000/hours;
    $('speed').textContent=session.speed.toFixed(1);$('maxSpeed').textContent=session.maxSpeed.toFixed(1)+' km/h';
    $('distance').textContent=(session.distance/1000).toFixed(2);$('pace').textContent=fmtPace(avg);
    $('altitude').textContent=session.altitude==null?'—':Math.round(session.altitude);
    $('elevation').textContent=Math.round(session.elevation);
    renderTime();
  }
  function onPosition(pos){
    if(!session||paused)return;
    const c={lat:pos.coords.latitude,lng:pos.coords.longitude,alt:pos.coords.altitude};
    const accuracy=pos.coords.accuracy||999;
    if(accuracy>45){setCoach('La señal GPS está buscando precisión. Esperemos unos segundos.');return}
    const prev=session.points[session.points.length-1];
    if(prev){
      const meters=haversine(prev,c),dt=Math.max((pos.timestamp-prev.t)/1000,1);
      // Reject obvious GPS jumps and stationary drift.
      if(meters>0.8&&meters/dt<12&&meters/dt>0.25){session.distance+=meters}
      if(c.alt!=null&&prev.alt!=null){const delta=c.alt-prev.alt;if(delta>1.5&&delta<30)session.elevation+=delta}
    }
    c.t=pos.timestamp;session.points.push(c);analyzeTerrain(c);
    if(session.points.length>1)track.addLatLng([c.lat,c.lng]);
    if(marker)marker.setLatLng([c.lat,c.lng]);else marker=L.circleMarker([c.lat,c.lng],{radius:8,color:'#fff',weight:3,fillColor:'#9e77cb',fillOpacity:1}).addTo(map);
    if(session.points.length===1)map.setView([c.lat,c.lng],16);
    const gpsSpeed=pos.coords.speed;
    let speed=(gpsSpeed!=null&&gpsSpeed>=0)?gpsSpeed*3.6:0;
    if(prev&&pos.timestamp>prev.t){const d=haversine(prev,c),v=d/((pos.timestamp-prev.t)/1000)*3.6;if(v>speed&&v<65)speed=v}
    if(speed>55)speed=0;
    session.speed=speed;session.maxSpeed=Math.max(session.maxSpeed,speed);
    session.altitude=c.alt;
    updateMetrics();coachCheck(speed);
  }
  function analyzeTerrain(point){
    if(point.alt==null)return;
    altitudeWindow.push({lat:point.lat,lng:point.lng,alt:point.alt});
    if(altitudeWindow.length>8)altitudeWindow.shift();
    if(altitudeWindow.length<5)return;
    const first=altitudeWindow[0],last=altitudeWindow[altitudeWindow.length-1];
    const horizontal=haversine(first,last);
    if(horizontal<35)return;
    const grade=((last.alt-first.alt)/horizontal)*100;
    const now=Date.now();
    if(now-lastTerrainAt<35000)return;
    if(grade>2.5){
      $('terrainIcon').textContent='↗';$('terrainMessage').textContent=`Subida detectada (${grade.toFixed(1)}%). Bajá un cambio antes de forzar y mantené un esfuerzo cómodo.`;
      lastTerrainAt=now;
    }else if(grade < -2.5){
      $('terrainIcon').textContent='↘';$('terrainMessage').textContent=`Bajada detectada (${Math.abs(grade).toFixed(1)}%). Controlá la velocidad y frená suavemente si hace falta.`;
      lastTerrainAt=now;
    }else{
      $('terrainIcon').textContent='→';$('terrainMessage').textContent='Terreno relativamente llano. Buscá un pedaleo fluido y relajado.';
    }
  }
  function averageSpeedSince(seconds, now){
    const values=speedSamples.filter(s=>now-s.t<=seconds*1000 && s.v>=3.5).map(s=>s.v);
    return values.length?values.reduce((a,b)=>a+b,0)/values.length:0;
  }
  function recentReference(now){
    // Best 30-second moving average seen during the last 3 minutes.
    let best=0;
    for(let end=now-30000;end<=now;end+=5000){
      const values=speedSamples.filter(s=>s.t>=end-30000&&s.t<=end&&s.v>=3.5).map(s=>s.v);
      if(values.length>=5){
        const avg=values.reduce((a,b)=>a+b,0)/values.length;
        if(avg>best)best=avg;
      }
    }
    return best;
  }
  function coachCheck(speed){
    const now=Date.now();
    speedSamples.push({t:now,v:speed});
    speedSamples=speedSamples.filter(s=>now-s.t<=180000);
    const currentAvg=averageSpeedSince(20,now);
    const reference=recentReference(now);
    if(speed<3.5){dropSince=0;return} // ignore stops, traffic lights and very slow GPS drift
    if(reference<5||currentAvg<3.5)return; // wait for enough real movement data
    const hasDropped=currentAvg<reference*0.80;
    if(hasDropped){
      if(!dropSince)dropSince=now;
      if(now-dropSince>=18000 && now-lastDropAlert>=150000){
        lastDropAlert=now;
        awaitingRecovery=true;
        setCoach('¡Sofi, atenta! Bajaste la velocidad. Levantemos de a poco, ¡dale que vos podés! Busquemos recuperar el ritmo con control.',true); $('breathGuidance').textContent='Acompañá el esfuerzo con respiración natural. No retengas el aire. Si aparece falta de aire intensa, dolor o mareo, detenete de forma segura.';
      }
      return;
    }
    dropSince=0;
    if(awaitingRecovery && currentAvg>=reference*0.90 && now-lastPraiseAt>=45000){
      awaitingRecovery=false;lastPraiseAt=now;
      setCoach('¡Eso, Sofi! Recuperaste el ritmo. Muy bien esa constancia, seguí trabajando con fuerza y control.',true);
    }
  }
  function breathingCue(kind='reminder'){
    const messages={
      reminder:'Sofi, chequeá tu respiración. Soltá los hombros, mantené el aire fluyendo y buscá un ritmo natural. No fuerces inhalaciones ni exhalaciones.',
      recovery:'Sofi, bajemos un punto la intensidad. Respiración natural, hombros sueltos y mirada al frente. Si te falta el aire, detenete en un lugar seguro y recuperate.',
      effort:'Sofi, registrá cómo sentís el esfuerzo. Si no podés decir una frase corta sin jadear, aflojá la intensidad.'
    };
    const msg=messages[kind]||messages.reminder;
    $('breathGuidance').textContent=msg;
    setCoach(msg,true);
  }
  function recordEffort(value){
    selectedEffort=Number(value);
    document.querySelectorAll('[data-effort]').forEach(btn=>btn.classList.toggle('selected',Number(btn.dataset.effort)===selectedEffort));
    const descriptions={
      2:'Suave: podés conversar sin dificultad.',
      4:'Cómodo: respiración algo más activa, podés hablar en frases.',
      6:'Intenso: hablás en frases cortas; sostenelo solo si te sentís bien.',
      8:'Muy intenso: reducí la carga si no podés hablar con comodidad.',
      10:'Máximo: no es un objetivo habitual de entrenamiento; bajá la intensidad y recuperate.'
    };
    $('effortResult').textContent=descriptions[selectedEffort];
    if(session){
      session.effortLog=session.effortLog||[];
      session.effortLog.push({t:elapsed(),level:selectedEffort});
    }
    if(selectedEffort>=8)breathingCue('recovery');
    else if(selectedEffort>=6)breathingCue('effort');
    else setCoach('Bien, Sofi. Registramos tu percepción del esfuerzo. Mantené una respiración natural y constante.');
  }
  function scheduledBreathingReminder(){
    if(!session||paused||!$('breathReminders').checked)return;
    const now=Date.now();
    if(!lastBreathReminder)lastBreathReminder=now;
    if(now-lastBreathReminder>=600000){
      lastBreathReminder=now;
      breathingCue('reminder');
    }
  }
  function start(){
    if(!('geolocation'in navigator)){toast('Este navegador no permite acceder al GPS.');return}
    if(!window.isSecureContext){toast('El GPS requiere una página HTTPS.');return}
    if(!session){session={points:[],distance:0,speed:0,maxSpeed:0,altitude:null,elevation:0};track.setLatLngs([]);marker=null;altitudeWindow=[];lastTerrainAt=0;speedSamples=[];lastBreathReminder=Date.now();dropSince=0;lastDropAlert=0;awaitingRecovery=false;lastPraiseAt=0, lastBreathReminder=0, selectedEffort=null;$('terrainIcon').textContent='↗';$('terrainMessage').textContent='Analizando el terreno con el GPS…'}
    paused=false;startedAt=Date.now();setActive(true);wakeWanted=true;requestWakeLock();
    $('startBtn').disabled=true;$('pauseBtn').disabled=false;$('finishBtn').disabled=false;
    $('pauseBtn').textContent='Ⅱ PAUSAR';$('mapHint').textContent='Recorrido en seguimiento';
    setCoach('¡Salida iniciada! Vamos a disfrutar el camino.',true);
    watchId=navigator.geolocation.watchPosition(onPosition,err=>{toast(err.code===1?'Necesitamos permiso de ubicación. Revisá Ajustes.':'No pudimos obtener el GPS. Probá en un lugar despejado.');setCoach('No llega la señal GPS. Revisá los permisos de ubicación.')},{enableHighAccuracy:true,maximumAge:1000,timeout:20000});
    timer=setInterval(()=>{renderTime();scheduledBreathingReminder()},1000);
  }
  function pause(){
    if(!session)return;
    if(!paused){elapsedBefore=elapsed();startedAt=0;paused=true;if(watchId!==null)navigator.geolocation.clearWatch(watchId);watchId=null;clearInterval(timer);wakeWanted=false;releaseWakeLock();wakeWanted=false;releaseWakeLock();$('pauseBtn').textContent='▶ REANUDAR';setActive(false);setCoach('Entrenamiento pausado. Tomate el tiempo que necesites.');}
    else{paused=false;startResume()}
  }
  function startResume(){
    startedAt=Date.now();setActive(true);wakeWanted=true;requestWakeLock();$('pauseBtn').textContent='Ⅱ PAUSAR';
    watchId=navigator.geolocation.watchPosition(onPosition,()=>toast('Se perdió la señal GPS.'),{enableHighAccuracy:true,maximumAge:1000,timeout:20000});
    timer=setInterval(()=>{renderTime();scheduledBreathingReminder()},1000);setCoach('¡Seguimos! Retomá a tu ritmo.',true);
  }
  function finish(){
    if(!session)return;
    if(watchId!==null)navigator.geolocation.clearWatch(watchId);watchId=null;clearInterval(timer);wakeWanted=false;releaseWakeLock();
    const total=elapsed(),avg=session.distance/1000/Math.max(total/3600,1/3600);
    if(session.distance>10){
      history.unshift({date:new Date().toISOString(),distance:session.distance/1000,duration:fmtTime(total),durationSeconds:total,avgSpeed:avg,maxSpeed:session.maxSpeed,elevation:session.elevation,effortLog:session.effortLog||[],points:session.points.map(p=>({lat:p.lat,lng:p.lng,alt:p.alt,t:p.t}))});
      localStorage.setItem('entrenamiento-history',JSON.stringify(history));renderHistory();
      setCoach(`¡Entrenamiento terminado! Hiciste ${(session.distance/1000).toFixed(2)} kilómetros. ¡Felicitaciones!`,true);
      toast('Salida guardada en este iPhone.');
    }else{setCoach('Salida finalizada. Cuando recorras más distancia, la guardaremos en tu historial.');toast('Salida demasiado corta para guardar.')}
    session=null;startedAt=0;elapsedBefore=0;paused=false;setActive(false);
    $('startBtn').disabled=false;$('pauseBtn').disabled=true;$('finishBtn').disabled=true;$('pauseBtn').textContent='Ⅱ PAUSAR';
    $('mapHint').textContent='Salida finalizada';$('speed').textContent='0.0';$('distance').textContent='0.00';$('pace').textContent='—';$('elapsed').textContent='00:00';$('altitude').textContent='—';$('elevation').textContent='0';$('maxSpeed').textContent='0.0 km/h';
  }
  document.querySelectorAll('[data-effort]').forEach(btn=>btn.addEventListener('click',()=>recordEffort(btn.dataset.effort)));
  $('breathNowBtn').addEventListener('click',()=>breathingCue('reminder'));
  $('startBtn').addEventListener('click',start);$('pauseBtn').addEventListener('click',pause);$('finishBtn').addEventListener('click',finish);
  $('centerMap').addEventListener('click',()=>{if(marker)map.setView(marker.getLatLng(),16);else toast('Tu ubicación aparecerá al iniciar la salida.')});
  $('wakeToggle').addEventListener('click',async()=>{
    wakeWanted=true;
    await requestWakeLock();
    if(!('wakeLock' in navigator))toast('Usá Ajustes > Pantalla y brillo > Bloqueo automático > Nunca.');
  });
  document.addEventListener('visibilitychange',()=>{
    if(document.visibilityState==='visible' && wakeWanted && session && !paused)requestWakeLock();
  });
  $('voiceToggle').addEventListener('click',()=>{voiceOn=!voiceOn;$('voiceToggle').textContent=voiceOn?'🔊':'🔇';$('voiceToggle').title=voiceOn?'Voz activada':'Voz desactivada';if(!voiceOn&&'speechSynthesis'in window)window.speechSynthesis.cancel();toast(voiceOn?'Entrenadora activada':'Entrenadora silenciada')});
  $('clearHistory').addEventListener('click',()=>{if(confirm('¿Borrar todas las salidas guardadas en este iPhone?')){history=[];localStorage.removeItem('entrenamiento-history');renderHistory()}});
  initMap();renderHistory();
  if('serviceWorker'in navigator&&location.protocol.startsWith('http'))navigator.serviceWorker.register('./sw.js').catch(()=>{});
})();