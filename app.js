(() => {
  const $ = id => document.getElementById(id);
  const fmtTime = s => {const h=Math.floor(s/3600),m=Math.floor(s%3600/60),sec=Math.floor(s%60);return h?`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`:`${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`};
  const fmtPace = speed => speed > 0.5 ? `${Math.floor(60/speed)}:${String(Math.round((60/speed%1)*60)%60).padStart(2,'0')}` : '—';
  const haversine = (a,b) => {const R=6371000,rad=x=>x*Math.PI/180,dLat=rad(b.lat-a.lat),dLon=rad(b.lng-a.lng),x=Math.sin(dLat/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dLon/2)**2;return 2*R*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));};
  let map, marker, track, watchId=null, timer=null, startedAt=0, elapsedBefore=0, paused=false, voiceOn=true, session=null, lastCoachAt=0, lowSpeedSince=0;
  let history = JSON.parse(localStorage.getItem('entrenamiento-history') || '[]');
  const defaultCenter=[-34.9214,-57.9544]; // La Plata, only initial map view; GPS centers on actual position.
  function initMap(){
    map=L.map('map',{zoomControl:false}).setView(defaultCenter,13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'}).addTo(map);
    L.control.zoom({position:'bottomleft'}).addTo(map);
    track=L.polyline([],{color:'#a879d5',weight:5,opacity:.95,lineCap:'round'}).addTo(map);
  }
  function toast(msg){const el=$('toast');el.textContent=msg;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),2800)}
  function say(msg){if(!voiceOn||!('speechSynthesis'in window))return;window.speechSynthesis.cancel();const u=new SpeechSynthesisUtterance(msg);u.lang='es-AR';u.rate=1.02;u.pitch=1.05;window.speechSynthesis.speak(u)}
  function setCoach(msg, speak=false){$('coachMessage').textContent=msg;if(speak)say(msg)}
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
      $('terrainIcon').textContent='↗';$('terrainMessage').textContent=`Pendiente ascendente detectada (${grade.toFixed(1)}%). Usá un cambio liviano y mantené un esfuerzo cómodo.`;
      lastTerrainAt=now;
    }else if(grade < -2.5){
      $('terrainIcon').textContent='↘';$('terrainMessage').textContent=`Pendiente descendente detectada (${Math.abs(grade).toFixed(1)}%). Controlá la velocidad y anticipá el frenado.`;
      lastTerrainAt=now;
    }else{
      $('terrainIcon').textContent='→';$('terrainMessage').textContent='Terreno relativamente llano. Buscá un pedaleo fluido y relajado.';
    }
  }
  function coachCheck(speed){
    const now=Date.now();if(now-lastCoachAt<45000)return;
    if(speed>0&&speed<8){
      if(!lowSpeedSince)lowSpeedSince=now;
      if(now-lowSpeedSince>25000){lastCoachAt=now;setCoach('Bajó tu velocidad. Si el camino está despejado y te sentís bien, probá recuperar el ritmo de a poco.',true);lowSpeedSince=0}
    }else if(speed>=8){lowSpeedSince=0;if(now-lastCoachAt>90000){lastCoachAt=now;setCoach('¡Muy bien! Mantené un ritmo cómodo y constante.',true)}}
  }
  function start(){
    if(!('geolocation'in navigator)){toast('Este navegador no permite acceder al GPS.');return}
    if(!window.isSecureContext){toast('El GPS requiere una página HTTPS.');return}
    if(!session){session={points:[],distance:0,speed:0,maxSpeed:0,altitude:null,elevation:0};track.setLatLngs([]);marker=null;altitudeWindow=[];lastTerrainAt=0;$('terrainIcon').textContent='↗';$('terrainMessage').textContent='Analizando el terreno con el GPS…'}
    paused=false;startedAt=Date.now();setActive(true);
    $('startBtn').disabled=true;$('pauseBtn').disabled=false;$('finishBtn').disabled=false;
    $('pauseBtn').textContent='Ⅱ PAUSAR';$('mapHint').textContent='Recorrido en seguimiento';
    setCoach('¡Salida iniciada! Vamos a disfrutar el camino.',true);
    watchId=navigator.geolocation.watchPosition(onPosition,err=>{toast(err.code===1?'Necesitamos permiso de ubicación. Revisá Ajustes.':'No pudimos obtener el GPS. Probá en un lugar despejado.');setCoach('No llega la señal GPS. Revisá los permisos de ubicación.')},{enableHighAccuracy:true,maximumAge:1000,timeout:20000});
    timer=setInterval(renderTime,1000);
  }
  function pause(){
    if(!session)return;
    if(!paused){elapsedBefore=elapsed();startedAt=0;paused=true;if(watchId!==null)navigator.geolocation.clearWatch(watchId);watchId=null;clearInterval(timer);$('pauseBtn').textContent='▶ REANUDAR';setActive(false);setCoach('Entrenamiento pausado. Tomate el tiempo que necesites.');}
    else{paused=false;startResume()}
  }
  function startResume(){
    startedAt=Date.now();setActive(true);$('pauseBtn').textContent='Ⅱ PAUSAR';
    watchId=navigator.geolocation.watchPosition(onPosition,()=>toast('Se perdió la señal GPS.'),{enableHighAccuracy:true,maximumAge:1000,timeout:20000});
    timer=setInterval(renderTime,1000);setCoach('¡Seguimos! Retomá a tu ritmo.',true);
  }
  function finish(){
    if(!session)return;
    if(watchId!==null)navigator.geolocation.clearWatch(watchId);watchId=null;clearInterval(timer);
    const total=elapsed(),avg=session.distance/1000/Math.max(total/3600,1/3600);
    if(session.distance>10){
      history.unshift({date:new Date().toISOString(),distance:session.distance/1000,duration:fmtTime(total),durationSeconds:total,avgSpeed:avg,maxSpeed:session.maxSpeed,elevation:session.elevation,points:session.points.map(p=>({lat:p.lat,lng:p.lng,alt:p.alt,t:p.t}))});
      localStorage.setItem('entrenamiento-history',JSON.stringify(history));renderHistory();
      setCoach(`¡Entrenamiento terminado! Hiciste ${(session.distance/1000).toFixed(2)} kilómetros. ¡Felicitaciones!`,true);
      toast('Salida guardada en este iPhone.');
    }else{setCoach('Salida finalizada. Cuando recorras más distancia, la guardaremos en tu historial.');toast('Salida demasiado corta para guardar.')}
    session=null;startedAt=0;elapsedBefore=0;paused=false;setActive(false);
    $('startBtn').disabled=false;$('pauseBtn').disabled=true;$('finishBtn').disabled=true;$('pauseBtn').textContent='Ⅱ PAUSAR';
    $('mapHint').textContent='Salida finalizada';$('speed').textContent='0.0';$('distance').textContent='0.00';$('pace').textContent='—';$('elapsed').textContent='00:00';$('altitude').textContent='—';$('elevation').textContent='0';$('maxSpeed').textContent='0.0 km/h';
  }
  $('startBtn').addEventListener('click',start);$('pauseBtn').addEventListener('click',pause);$('finishBtn').addEventListener('click',finish);
  $('centerMap').addEventListener('click',()=>{if(marker)map.setView(marker.getLatLng(),16);else toast('Tu ubicación aparecerá al iniciar la salida.')});
  $('voiceToggle').addEventListener('click',()=>{voiceOn=!voiceOn;$('voiceToggle').textContent=voiceOn?'🔊':'🔇';$('voiceToggle').title=voiceOn?'Voz activada':'Voz desactivada';if(!voiceOn&&'speechSynthesis'in window)window.speechSynthesis.cancel();toast(voiceOn?'Entrenadora activada':'Entrenadora silenciada')});
  $('clearHistory').addEventListener('click',()=>{if(confirm('¿Borrar todas las salidas guardadas en este iPhone?')){history=[];localStorage.removeItem('entrenamiento-history');renderHistory()}});
  initMap();renderHistory();
  if('serviceWorker'in navigator&&location.protocol.startsWith('http'))navigator.serviceWorker.register('./sw.js').catch(()=>{});
})();