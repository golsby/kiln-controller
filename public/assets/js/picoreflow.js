var state = "IDLE";
var state_last = "";
var graph = [ 'profile', 'live'];
var points = [];
var profiles = [];
var time_mode = 0;
var selected_profile = 0;
var selected_profile_name = 'cone-05-long-bisque.json';
var temp_scale = "c";
var time_scale_slope = "s";
var time_scale_profile = "s";
var time_scale_long = "Seconds";
var temp_scale_display = "C";
var kwh_rate = 0.26;
var currency_type = "EUR";
var run_log = []
var manual_hold = false;
var segment_editor_count = -1;
var segment_signature = "";
var segments_armed = false;       // Edit button toggled on (graph clickable)
var selected_segment = -1;        // the one segment currently unlocked to edit
var segment_end_times = [];        // nominal end time (s) of each segment, for click mapping

var protocol = 'ws:';
if (window.location.protocol == 'https:') {
    protocol = 'wss:';
}
var host = "" + protocol + "//" + window.location.hostname + ":" + window.location.port;
var ws_status = new WebSocket(host+"/status");
var ws_control = new WebSocket(host+"/control");
var ws_config = new WebSocket(host+"/config");
var ws_storage = new WebSocket(host+"/storage");


if(window.webkitRequestAnimationFrame) window.requestAnimationFrame = window.webkitRequestAnimationFrame;

graph.profile =
{
    label: "Profile",
    data: [],
    points: { show: false },
    color: "#28b62c",
    draggable: false
};

graph.live =
{
    label: "Live",
    data: [],
    points: { show: false },
    color: "#e80909",
    draggable: false
};


function updateProfile(id)
{
    selected_profile = id;
    selected_profile_name = profiles[id].name;
    var job_seconds = profiles[id].data.length === 0 ? 0 : parseInt(profiles[id].data[profiles[id].data.length-1][0]);
    var kwh = (3850*job_seconds/3600/1000).toFixed(2);
    var cost =  (kwh*kwh_rate).toFixed(2);
    var job_time = new Date(job_seconds * 1000).toISOString().substr(11, 8);
    $('#sel_prof').html(profiles[id].name);
    $('#sel_prof_eta').html(job_time);
    $('#sel_prof_cost').html(kwh + ' kWh ('+ currency_type +': '+ cost +')');
    graph.profile.data = profiles[id].data;
    graph.plot = $.plot("#graph_container", [ graph.profile, graph.live ] , getOptions());
    populateAimSegments(id);
}

// mirror of the server's segment derivation so segment indices line up
// (rate in deg/hr, hold in seconds)
function deriveSegments(profile)
{
    if (profile.rth && profile.rth.length) {
        return profile.rth.map(function(r){ return {rate: r[0], target: r[1], hold: r[2]*3600}; });
    }
    var pts = (profile.data || []).slice().sort(function(a,b){ return a[0]-b[0]; });
    var segs = [];
    for (var i=1; i<pts.length; i++) {
        var t0 = pts[i-1][0], T0 = pts[i-1][1], t1 = pts[i][0], T1 = pts[i][1];
        var dt = t1 - t0;
        if (dt <= 0) continue;
        if (T1 === T0) {
            // flat run = hold; merged onto the previous segment if same temp
            if (segs.length && segs[segs.length-1].target === T1) { segs[segs.length-1].hold += dt; }
            else segs.push({rate: 0, target: T1, hold: dt});
        } else {
            segs.push({rate: Math.abs(T1-T0)/dt*3600, target: T1, hold: 0});
        }
    }
    return segs;
}

// nominal seconds to reach segment `index`'s target temp from startTemp
// (mirrors Profile.nominal_time_to_segment on the server)
function timeToSegmentTarget(segs, startTemp, index)
{
    var t = 0.0, temp = startTemp;
    for (var i=0; i<segs.length; i++) {
        var ratePerSec = segs[i].rate / 3600.0;
        if (ratePerSec > 0 && segs[i].target !== temp) t += Math.abs(segs[i].target - temp) / ratePerSec;
        if (i === index) return t;
        temp = segs[i].target;
        t += segs[i].hold;
    }
    return t;
}

function formatDuration(seconds)
{
    var s = Math.round(seconds);
    var h = Math.floor(s / 3600);
    var m = Math.round((s - h*3600) / 60);
    if (m === 60) { h += 1; m = 0; }
    return h > 0 ? (h + 'h ' + m + 'm') : (m + 'm');
}

function populateAimSegments(id)
{
    var profile = profiles[id];
    var segs = deriveSegments(profile);
    var startTemp = (profile.data && profile.data.length) ? profile.data[0][1] : 0;
    var opts = '';
    for (var i=0; i<segs.length; i++) {
        var eta = formatDuration(timeToSegmentTarget(segs, startTemp, i));
        opts += '<option value="'+i+'">Segment '+(i+1)+' — '+Math.round(segs[i].target)+'°'+temp_scale_display+' ('+eta+')</option>';
    }
    $('#aim_segment').html(opts);
}

function toggleAim()
{
    if ($('#aim_enable').is(':checked')) { $('#aim_fields').slideDown(); }
    else { $('#aim_fields').slideUp(); }
}

function deleteProfile()
{
    var profile = { "type": "profile", "data": "", "name": selected_profile_name };
    var delete_struct = { "cmd": "DELETE", "profile": profile };

    var delete_cmd = JSON.stringify(delete_struct);
    console.log("Delete profile:" + selected_profile_name);

    ws_storage.send(delete_cmd);

    ws_storage.send('GET');
    selected_profile_name = profiles[0].name;

    state="IDLE";
    $('#edit').hide();
    $('#profile_selector').show();
    $('#btn_controls').show();
    $('#status').slideDown();
    $('#profile_table').slideUp();
    $('#e2').select2('val', 0);
    graph.profile.points.show = false;
    graph.profile.draggable = false;
    graph.plot = $.plot("#graph_container", [ graph.profile, graph.live ], getOptions());
}


function updateProgress(percentage)
{
    if(state=="RUNNING")
    {
        if(percentage > 100) percentage = 100;
        $('#progressBar').css('width', percentage+'%');
        if(percentage>5) $('#progressBar').html(parseInt(percentage)+'%');
    }
    else
    {
        $('#progressBar').css('width', 0+'%');
        $('#progressBar').html('');
    }
}

function updateProfileTable()
{
    var dps = 0;
    var slope = "";
    var color = "";

    var html = '<h3>Schedule Points</h3><div class="table-responsive" style="scroll: none"><table class="table table-striped">';
        html += '<tr><th style="width: 50px">#</th><th>Target Time in ' + time_scale_long+ '</th><th>Target Temperature in °'+temp_scale_display+'</th><th>Slope in &deg;'+temp_scale_display+'/'+time_scale_slope+'</th><th></th></tr>';

    for(var i=0; i<graph.profile.data.length;i++)
    {

        if (i>=1) dps =  ((graph.profile.data[i][1]-graph.profile.data[i-1][1])/(graph.profile.data[i][0]-graph.profile.data[i-1][0]) * 10) / 10;
        if (dps  > 0) { slope = "up";     color="rgba(206, 5, 5, 1)"; } else
        if (dps  < 0) { slope = "down";   color="rgba(23, 108, 204, 1)"; dps *= -1; } else
        if (dps == 0) { slope = "right";  color="grey"; }

        html += '<tr><td><h4>' + (i+1) + '</h4></td>';
        html += '<td><input type="text" class="form-control" id="profiletable-0-'+i+'" value="'+ timeProfileFormatter(graph.profile.data[i][0],true) + '" style="width: 60px" /></td>';
        html += '<td><input type="text" class="form-control" id="profiletable-1-'+i+'" value="'+ graph.profile.data[i][1] + '" style="width: 60px" /></td>';
        html += '<td><div class="input-group"><span class="glyphicon glyphicon-circle-arrow-' + slope + ' input-group-addon ds-trend" style="background: '+color+'"></span><input type="text" class="form-control ds-input" readonly value="' + formatDPS(dps) + '" style="width: 100px" /></div></td>';
        html += '<td>&nbsp;</td></tr>';
    }

    html += '</table></div>';

    $('#profile_table').html(html);

    //Link table to graph
    $(".form-control").change(function(e)
        {
            var id = $(this)[0].id; //e.currentTarget.attributes.id
            var value = parseInt($(this)[0].value);
            var fields = id.split("-");
            var col = parseInt(fields[1]);
            var row = parseInt(fields[2]);

            if (graph.profile.data.length > 0) {
            if (col == 0) {
                graph.profile.data[row][col] = timeProfileFormatter(value,false);
            }
            else {
                graph.profile.data[row][col] = value;
            }

            graph.plot = $.plot("#graph_container", [ graph.profile, graph.live ], getOptions());
            }
            updateProfileTable();

        });
}

function timeProfileFormatter(val, down) {
    var rval = val
    switch(time_scale_profile){
        case "m":
            if (down) {rval = val / 60;} else {rval = val * 60;}
            break;
        case "h":
            if (down) {rval = val / 3600;} else {rval = val * 3600;}
            break;
    }
    return Math.round(rval);
}

function formatDPS(val) {
    var tval = val;
    if (time_scale_slope == "m") {
        tval = val * 60;
    }
    if (time_scale_slope == "h") {
        tval = (val * 60) * 60;
    }
    return Math.round(tval);
}

function hazardTemp(){

    if (temp_scale == "f") {
        return (1500 * 9 / 5) + 32
    }
    else {
        return 1500
    }
}

function timeTickFormatter(val,axis)
{
// hours
if(axis.max>3600) {
  //var hours = Math.floor(val / (3600));
  //return hours;
  return Math.floor(val/3600);
  }

// minutes
if(axis.max<=3600) {
  return Math.floor(val/60);
  }

// seconds
if(axis.max<=60) {
  return val;
  }
}

function runTask()
{
    var cmd =
    {
        "cmd": "RUN",
        "profile": profiles[selected_profile]
    }

    // aimed start: reach the chosen segment's temperature at the given time
    if ($('#aim_enable').is(':checked')) {
        var tval = $('#aim_time').val();
        if (tval) {
            cmd.aim_segment = parseInt($('#aim_segment').val());
            cmd.aim_time = Math.floor(new Date(tval).getTime() / 1000);
        }
    }

    graph.live.data = [];
    graph.plot = $.plot("#graph_container", [ graph.profile, graph.live ] , getOptions());

    ws_control.send(JSON.stringify(cmd));

}

function runTaskSimulation()
{
    var cmd =
    {
        "cmd": "SIMULATE",
        "profile": profiles[selected_profile]
    }

    graph.live.data = [];
    graph.plot = $.plot("#graph_container", [ graph.profile, graph.live ] , getOptions());

    ws_control.send(JSON.stringify(cmd));

}


function abortTask()
{
    var cmd = {"cmd": "STOP"};
    ws_control.send(JSON.stringify(cmd));
}

function toggleHold()
{
    // manual_hold is kept in sync from the status feed; send the opposite
    var cmd = manual_hold ? "RESUME" : "HOLD";
    ws_control.send(JSON.stringify({"cmd": cmd}));
}

function advanceSegment()
{
    ws_control.send(JSON.stringify({"cmd": "ADVANCE"}));
}

function holdLabel(seconds)
{
    if (seconds <= 0) return '-';
    return seconds >= 3600 ? (seconds/3600).toFixed(1)+'h' : Math.round(seconds/60)+'m';
}

function renderSegmentEditor(segments, active)
{
    var html = '<button id="nav_edit_segments" type="button" class="btn btn-default btn-sm" onclick="toggleSegmentsEdit()" style="float:right; margin-top:4px"><span class="glyphicon glyphicon-edit"></span> Edit</button>';
    html += '<h4>Segments <small>(click Edit, then click a segment on the graph to change it)</small></h4>';
    html += '<div class="table-responsive"><table class="table table-condensed" style="margin-bottom:0">';
    html += '<tr><th style="width:40px">#</th><th>Rate &deg;'+temp_scale_display+'/hr</th><th>Target &deg;'+temp_scale_display+'</th><th>Hold (min)</th></tr>';
    for (var i=0; i<segments.length; i++)
    {
        var s = segments[i];
        var cls = (i === active) ? ' class="info"' : '';
        html += '<tr'+cls+'><td>'+(i+1)+'</td>';
        html += '<td>'+Math.round(s.rate)+'</td>';
        html += '<td><input type="number" class="form-control input-sm seg-target" data-seg="'+i+'" value="'+Math.round(s.target)+'" style="width:90px" /></td>';
        html += '<td><input type="number" min="0" class="form-control input-sm seg-hold" data-seg="'+i+'" value="'+Math.round(s.hold/60)+'" style="width:90px" /></td></tr>';
    }
    html += '</table></div>';
    $('#segment_table').html(html);
    applySegmentsEditable();  // start locked (read-only) unless edit mode is on

    $('.seg-target').change(function()
    {
        var idx = parseInt($(this).attr('data-seg'));
        var val = parseFloat($(this).val());
        if (!isNaN(val)) {
            ws_control.send(JSON.stringify({"cmd": "SET_SEGMENT_TARGET", "segment": idx, "target": val}));
        }
    });

    $('.seg-hold').change(function()
    {
        var idx = parseInt($(this).attr('data-seg'));
        var mins = parseFloat($(this).val());
        if (!isNaN(mins) && mins >= 0) {
            // backend works in seconds
            ws_control.send(JSON.stringify({"cmd": "SET_SEGMENT_HOLD", "segment": idx, "hold": mins * 60}));
        }
    });
}

function applySegmentsEditable()
{
    // All fields locked by default. Only the segment the user explicitly
    // selected (by clicking it on the graph) while armed is editable, so a
    // stray edit can't change a live firing.
    $('.seg-target, .seg-hold').prop('disabled', true);
    $('#segment_table tr').removeClass('warning');
    if (segments_armed && selected_segment >= 0) {
        $('.seg-target[data-seg="'+selected_segment+'"], .seg-hold[data-seg="'+selected_segment+'"]').prop('disabled', false);
        $('#segment_table tr').eq(selected_segment + 1).addClass('warning');
    }
    if (segments_armed) {
        $('#nav_edit_segments').removeClass('btn-default').addClass('btn-warning')
            .html('<span class="glyphicon glyphicon-ok"></span> Done');
    } else {
        $('#nav_edit_segments').removeClass('btn-warning').addClass('btn-default')
            .html('<span class="glyphicon glyphicon-edit"></span> Edit');
    }
}

function toggleSegmentsEdit()
{
    segments_armed = !segments_armed;
    selected_segment = -1;  // arming selects nothing; disarming clears
    applySegmentsEditable();
    if (segments_armed) {
        $.bootstrapGrowl("<span class=\"glyphicon glyphicon-hand-up\"></span> Click a segment on the graph to edit it", {
            ele: 'body', type: 'info', offset: {from: 'top', amount: 250},
            align: 'center', width: 385, delay: 4000, allow_dismiss: true });
    }
}

function selectSegment(seg)
{
    if (seg < 0 || seg >= segment_editor_count) return;
    selected_segment = seg;
    applySegmentsEditable();
    $('.seg-target[data-seg="'+seg+'"]').focus();
}

// nominal end time (seconds) of each segment, used to map a graph click to
// the segment whose span contains that time
function segmentEndTimes(segments, startTemp)
{
    var t = 0.0, temp = startTemp, ends = [];
    for (var i=0; i<segments.length; i++) {
        var s = segments[i], ratePerSec = s.rate / 3600.0;
        if (temp !== s.target) {
            if (ratePerSec > 0) t += Math.abs(s.target - temp) / ratePerSec;
            temp = s.target;
        }
        if (s.hold > 0) t += s.hold;
        ends.push(t);
    }
    return ends;
}

function segmentAtTime(x)
{
    for (var i=0; i<segment_end_times.length; i++) {
        if (x <= segment_end_times[i]) return i;
    }
    return segment_end_times.length - 1;  // past the end -> last segment
}

// Mirror of the server's segments_to_points: build the ideal time/temp
// curve from the (possibly edited) segments so the green line stays in sync.
function segmentsToPoints(segments, startTemp)
{
    var t = 0.0;
    var temp = startTemp;
    var pts = [[0, temp]];
    for (var i=0; i<segments.length; i++)
    {
        var s = segments[i];
        var ratePerSec = s.rate / 3600.0;
        if (temp !== s.target) {
            if (ratePerSec > 0) t += Math.abs(s.target - temp) / ratePerSec;
            temp = s.target;
            pts.push([Math.round(t), temp]);
        }
        if (s.hold > 0) {
            t += s.hold;
            pts.push([Math.round(t), temp]);
        }
    }
    return pts;
}

function manageSegmentEditor(x)
{
    if (!x.segments) return;
    var sig = JSON.stringify(x.segments.map(function(s){ return [s.target, s.hold]; }));
    // keep the click->segment time map current with any edits
    segment_end_times = segmentEndTimes(x.segments, x.start_temp);
    // (re)build the table only when the segment set changes (new run);
    // otherwise just move the active-row highlight so we never clobber a
    // field being edited
    if (x.segments.length !== segment_editor_count) {
        segment_editor_count = x.segments.length;
        segment_signature = sig;  // baseline; keep the as-loaded green curve
        segments_armed = false;     // every new run starts locked (safe)
        selected_segment = -1;
        renderSegmentEditor(x.segments, x.segment);
    } else {
        $('#segment_table tr').removeClass('info');
        if (x.segment !== null && x.segment !== undefined) {
            $('#segment_table tr').eq(x.segment + 1).addClass('info');
        }
        // a target/hold was edited -> rebuild the ideal (green) curve so it
        // reflects the change. The per-tick replot below renders it.
        if (sig !== segment_signature) {
            segment_signature = sig;
            graph.profile.data = segmentsToPoints(x.segments, x.start_temp);
        }
    }
}

function updateHoldButton()
{
    if (manual_hold) {
        // blue (not green) so Resume isn't confused with the green Start button
        $('#nav_hold').removeClass('btn-warning').addClass('btn-info')
            .html('<span class="glyphicon glyphicon-play"></span> Resume');
    } else {
        $('#nav_hold').removeClass('btn-info').addClass('btn-warning')
            .html('<span class="glyphicon glyphicon-pause"></span> Hold');
    }
}

function clearProfile()
{
    if (state == "RUNNING") return;

    // tell the server to drop the recorded run trace so a reconnecting
    // browser doesn't reload it (the selected profile is kept)
    ws_control.send(JSON.stringify({"cmd": "CLEAR"}));

    // clear only the run-time (live) trace; leave the selected profile,
    // its green curve, and the dropdown selection in place
    graph.live.data = [];
    graph.plot = $.plot("#graph_container", [ graph.profile, graph.live ], getOptions());

    run_log = [];
    $('#target_temp').html('---');
    updateProgress(0);
}

function enterNewMode()
{
    state="EDIT"
    $('#status').slideUp();
    $('#edit').show();
    $('#profile_selector').hide();
    $('#btn_controls').hide();
    $('#form_profile_name').attr('value', '');
    $('#form_profile_name').attr('placeholder', 'Please enter a name');
    graph.profile.points.show = true;
    graph.profile.draggable = true;
    graph.profile.data = [];
    graph.plot = $.plot("#graph_container", [ graph.profile, graph.live ], getOptions());
    updateProfileTable();
}

function enterEditMode()
{
    state="EDIT"
    $('#status').slideUp();
    $('#edit').show();
    $('#profile_selector').hide();
    $('#btn_controls').hide();
    console.log(profiles);
    $('#form_profile_name').val(profiles[selected_profile].name);
    graph.profile.points.show = true;
    graph.profile.draggable = true;
    graph.plot = $.plot("#graph_container", [ graph.profile, graph.live ], getOptions());
    updateProfileTable();
}

function leaveEditMode()
{
    selected_profile_name = $('#form_profile_name').val();
    ws_storage.send('GET');
    state="IDLE";
    $('#edit').hide();
    $('#profile_selector').show();
    $('#btn_controls').show();
    $('#status').slideDown();
    $('#profile_table').slideUp();
    graph.profile.points.show = false;
    graph.profile.draggable = false;
    graph.plot = $.plot("#graph_container", [ graph.profile, graph.live ], getOptions());
}

function newPoint()
{
    if(graph.profile.data.length > 0)
    {
        var pointx = parseInt(graph.profile.data[graph.profile.data.length-1][0])+15;
    }
    else
    {
        var pointx = 0;
    }
    graph.profile.data.push([pointx, Math.floor((Math.random()*230)+25)]);
    graph.plot = $.plot("#graph_container", [ graph.profile, graph.live ], getOptions());
    updateProfileTable();
}

function delPoint()
{
    graph.profile.data.splice(-1,1)
    graph.plot = $.plot("#graph_container", [ graph.profile, graph.live ], getOptions());
    updateProfileTable();
}

function toggleTable()
{
    if($('#profile_table').css('display') == 'none')
    {
        $('#profile_table').slideDown();
    }
    else
    {
        $('#profile_table').slideUp();
    }
}

function saveProfile()
{
    name = $('#form_profile_name').val();
    var rawdata = graph.plot.getData()[0].data
    var data = [];
    var last = -1;

    for(var i=0; i<rawdata.length;i++)
    {
        if(rawdata[i][0] > last)
        {
          data.push([rawdata[i][0], rawdata[i][1]]);
        }
        else
        {
          $.bootstrapGrowl("<span class=\"glyphicon glyphicon-exclamation-sign\"></span> <b>ERROR 88:</b><br/>An oven is not a time-machine", {
            ele: 'body', // which element to append to
            type: 'alert', // (null, 'info', 'error', 'success')
            offset: {from: 'top', amount: 250}, // 'top', or 'bottom'
            align: 'center', // ('left', 'right', or 'center')
            width: 385, // (integer, or 'auto')
            delay: 5000,
            allow_dismiss: true,
            stackup_spacing: 10 // spacing between consecutively stacked growls.
          });

          return false;
        }

        last = rawdata[i][0];
    }

    var profile = { "type": "profile", "data": data, "name": name }
    var put = { "cmd": "PUT", "profile": profile }

    var put_cmd = JSON.stringify(put);

    ws_storage.send(put_cmd);

    leaveEditMode();
}

function get_tick_size() {
//switch(time_scale_profile){
//  case "s":
//    return 1;
//  case "m":
//    return 60;
//  case "h":
//    return 3600;
//  }
return 3600;
}

function getOptions()
{

  var options =
  {

    series:
    {
        lines:
        {
            show: true
        },

        points:
        {
            show: true,
            radius: 0,
            symbol: "circle"
        },

        shadowSize: 0

    },

	xaxis:
    {
      min: 0,
      tickColor: 'rgba(216, 211, 197, 0.2)',
      tickFormatter: timeTickFormatter,
      tickSize: get_tick_size(),
      font:
      {
        size: 12,
        lineHeight: 12,        weight: "normal",
        family: "courier",
        variant: "small-caps",
        color: "rgba(0,0,0, 0.6)"
      }
	},

	yaxis:
    {
      min: 0,
      tickDecimals: 0,
      draggable: false,
      tickColor: 'rgba(216, 211, 197, 0.2)',
      font:
      {
        size: 12,
        lineHeight: 12,
        weight: "normal",
        family: "courier",
        variant: "small-caps",
        color: "rgba(0,0,0, 0.6)"
      }
	},

	grid:
    {
	  color: 'rgba(216, 211, 197, 0.55)',
      borderWidth: 1,
      labelMargin: 10,
      mouseActiveRadius: 50,
      clickable: true
	},

    legend:
    {
      show: false
    }
  }

  return options;

}

function saveLog()
{
    exportToCsv('kiln.csv', run_log);
}

function exportToCsv(filename, rows) {
    var processRow = function (row) {
        var finalVal = '';
        for (var j = 0; j < row.length; j++) {
            var innerValue = row[j] === null ? '' : row[j].toString();
            if (row[j] instanceof Date) {
                innerValue = row[j].toLocaleString();
            };
            var result = innerValue.replace(/"/g, '""');
            if (result.search(/("|,|\n)/g) >= 0)
                result = '"' + result + '"';
            if (j > 0)
                finalVal += ',';
            finalVal += result;
        }
        return finalVal + '\n';
    };

    var csvFile = '';
    for (var i = 0; i < rows.length; i++) {
        csvFile += processRow(rows[i]);
    }

    var blob = new Blob([csvFile], { type: 'text/csv;charset=utf-8;' });
    if (navigator.msSaveBlob) { // IE 10+
        navigator.msSaveBlob(blob, filename);
    } else {
        var link = document.createElement("a");
        if (link.download !== undefined) { // feature detection
            // Browsers that support HTML5 download attribute
            var url = URL.createObjectURL(blob);
            link.setAttribute("href", url);
            link.setAttribute("download", filename);
            link.style.visibility = 'hidden';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        }
    }
}



$(document).ready(function()
{

    if(!("WebSocket" in window))
    {
        $('#chatLog, input, button, #examples').fadeOut("fast");
        $('<p>Oh no, you need a browser that supports WebSockets. How about <a href="http://www.google.com/chrome">Google Chrome</a>?</p>').appendTo('#container');
    }
    else
    {

        // Status Socket ////////////////////////////////

        ws_status.onopen = function()
        {
            console.log("Status Socket has been opened");

//            $.bootstrapGrowl("<span class=\"glyphicon glyphicon-exclamation-sign\"></span>Getting data from server",
//            {
//            ele: 'body', // which element to append to
//            type: 'success', // (null, 'info', 'error', 'success')
//            offset: {from: 'top', amount: 250}, // 'top', or 'bottom'
//            align: 'center', // ('left', 'right', or 'center')
//            width: 385, // (integer, or 'auto')
//            delay: 2500,
//            allow_dismiss: true,
//            stackup_spacing: 10 // spacing between consecutively stacked growls.
//            });
        };

        ws_status.onclose = function()
        {
            $.bootstrapGrowl("<span class=\"glyphicon glyphicon-exclamation-sign\"></span> <b>ERROR 1:</b><br/>Status Websocket not available", {
            ele: 'body', // which element to append to
            type: 'error', // (null, 'info', 'error', 'success')
            offset: {from: 'top', amount: 250}, // 'top', or 'bottom'
            align: 'center', // ('left', 'right', or 'center')
            width: 385, // (integer, or 'auto')
            delay: 5000,
            allow_dismiss: true,
            stackup_spacing: 10 // spacing between consecutively stacked growls.
          });
        };

        ws_status.onmessage = function(e)
        {
            //console.log("received status data")
            //console.log(e.data);

            x = JSON.parse(e.data);
            if (x.type == "backlog")
            {
                if (x.profile)
                {
                    selected_profile_name = x.profile.name;
                    $.each(profiles,  function(i,v) {
                        if(v.name == x.profile.name) {
                            updateProfile(i);
                            $('#e2').select2('val', i);
                        }
                    });
                }

                $.each(x.log, function(i,v) {
                    graph.live.data.push([v.runtime, v.temperature]);
                });
                graph.plot = $.plot("#graph_container", [ graph.profile, graph.live ] , getOptions());
            }

            if(state!="EDIT")
            {
                state = x.state;

                if (state!=state_last)
                {
                    if (state == 'RUNNING' && (state_last == 'IDLE' || state_last == 'WAITING')) {
                        run_log = [['time','target','temp','heat','pid.error','pid.errorDelta','pid.p','pid.i','pid.d','pid.kp','pdi.ki','pid.kd']]
                    }
                    if(state_last == "RUNNING")
                    {
                        if (state.includes("ERROR")) {
                            $('#target_temp').html('---');
                            updateProgress(0);
                            $.bootstrapGrowl("<span class=\"glyphicon glyphicon-exclamation-sign\"></span> <b>" + state + "</b>", {
                            ele: 'body', // which element to append to
                            type: 'error', // (null, 'info', 'error', 'success')
                            offset: {from: 'top', amount: 250}, // 'top', or 'bottom'
                            align: 'center', // ('left', 'right', or 'center')
                            width: 385, // (integer, or 'auto')
                            delay: 0,
                            allow_dismiss: true,
                            stackup_spacing: 10 // spacing between consecutively stacked growls.
                            });
                        }
                        else {
                            $('#target_temp').html('---');
                            updateProgress(0);
                            $.bootstrapGrowl("<span class=\"glyphicon glyphicon-exclamation-sign\"></span> <b>Run completed</b>", {
                            ele: 'body', // which element to append to
                            type: 'success', // (null, 'info', 'error', 'success')
                            offset: {from: 'top', amount: 250}, // 'top', or 'bottom'
                            align: 'center', // ('left', 'right', or 'center')
                            width: 385, // (integer, or 'auto')
                            delay: 0,
                            allow_dismiss: true,
                            stackup_spacing: 10 // spacing between consecutively stacked growls.
                            });
                        }
                    }
                }

                if(state=="RUNNING")
                {
                    run_log.push([
                        x.pidstats.time,
                        x.target,
                        x.temperature,
                        x.heat,
                        x.pidstats.err,
                        x.pidstats.errDelta,
                        x.pidstats.p,
                        x.pidstats.i,
                        x.pidstats.d,
                        x.pidstats.kp,
                        x.pidstats.ki,
                        x.pidstats.kd
                    ]);

                    $("#nav_start").hide();
                    $("#nav_stop").show();
                    $("#nav_hold").show();
                    $("#nav_advance").show();
                    $("#nav_clear").hide();

                    manual_hold = (x.manual_hold === true);
                    updateHoldButton();

                    $("#segment_table").show();
                    manageSegmentEditor(x);

                    graph.live.data.push([x.runtime, x.temperature]);
                    graph.plot = $.plot("#graph_container", [ graph.profile, graph.live ] , getOptions());

                    left = parseInt(x.totaltime-x.runtime);
                    eta = new Date(left * 1000).toISOString().substr(11, 8);

                    updateProgress(parseFloat(x.runtime)/parseFloat(x.totaltime)*100);
                    $('#state').html('<span class="glyphicon glyphicon-time" style="font-size: 22px; font-weight: normal"></span>&nbsp;<span>' + eta + '</span>');
                    $('#target_temp').html(parseInt(x.target));
                    $('#cost').html(x.currency_type + parseFloat(x.cost).toFixed(2));
                  


                }
                else if (state == "WAITING")
                {
                    // aimed start: waiting (idle, no heat) for the start time
                    $("#nav_start").hide();
                    $("#nav_stop").show();   // Stop cancels the scheduled start
                    $("#nav_hold").hide();
                    $("#nav_advance").hide();
                    $("#nav_clear").hide();
                    $("#segment_table").hide();
                    var wleft = parseInt(x.wait_remaining || 0);
                    var weta = new Date(wleft * 1000).toISOString().substr(11, 8);
                    updateProgress(0);
                    $('#state').html('<span class="glyphicon glyphicon-time"></span>&nbsp;Starts in ' + weta);
                    $('#target_temp').html('---');
                }
                else
                {
                    $("#nav_start").show();
                    $("#nav_stop").hide();
                    $("#nav_hold").hide();
                    $("#nav_advance").hide();
                    $("#nav_clear").show();
                    $("#segment_table").hide();
                    segment_editor_count = -1;  // rebuild fresh on the next run
                    segments_armed = false;     // re-lock for the next run
                    selected_segment = -1;
                    $('#state').html('<p class="ds-text">'+state+'</p>');
                }

                if (x.watcher_alarm) { $('#watcher_alarm').show(); } else { $('#watcher_alarm').hide(); }

                $('#act_temp').html(parseInt(x.temperature));
                $('#heat').html('<div class="bar" style="height:'+x.pidstats.out*70+'%;"></div>')
                if (x.cool > 0.5) { $('#cool').addClass("ds-led-cool-active"); } else { $('#cool').removeClass("ds-led-cool-active"); }
                if (x.air > 0.5) { $('#air').addClass("ds-led-air-active"); } else { $('#air').removeClass("ds-led-air-active"); }
                if (x.temperature > hazardTemp()) { $('#hazard').addClass("ds-led-hazard-active"); } else { $('#hazard').removeClass("ds-led-hazard-active"); }
                if ((x.door == "OPEN") || (x.door == "UNKNOWN")) { $('#door').addClass("ds-led-door-open"); } else { $('#door').removeClass("ds-led-door-open"); }

                state_last = state;

            }
        };

        // Config Socket /////////////////////////////////

        ws_config.onopen = function()
        {
            ws_config.send('GET');
        };

        ws_config.onmessage = function(e)
        {
            console.log (e.data);
            x = JSON.parse(e.data);
            temp_scale = x.temp_scale;
            time_scale_slope = x.time_scale_slope;
            time_scale_profile = x.time_scale_profile;
            kwh_rate = x.kwh_rate;
            currency_type = x.currency_type;

            if (temp_scale == "c") {temp_scale_display = "C";} else {temp_scale_display = "F";}


            $('#act_temp_scale').html('º'+temp_scale_display);
            $('#target_temp_scale').html('º'+temp_scale_display);

            switch(time_scale_profile){
                case "s":
                    time_scale_long = "Seconds";
                    break;
                case "m":
                    time_scale_long = "Minutes";
                    break;
                case "h":
                    time_scale_long = "Hours";
                    break;
            }

        }

        // Control Socket ////////////////////////////////

        ws_control.onopen = function()
        {

        };

        ws_control.onmessage = function(e)
        {
            //Data from Simulation
            console.log ("control socket has been opened")
            console.log (e.data);
            x = JSON.parse(e.data);
            graph.live.data.push([x.runtime, x.temperature]);
            graph.plot = $.plot("#graph_container", [ graph.profile, graph.live ] , getOptions());

        }

        // Storage Socket ///////////////////////////////

        ws_storage.onopen = function()
        {
            ws_storage.send('GET');
        };


        ws_storage.onmessage = function(e)
        {
            message = JSON.parse(e.data);

            if(message.resp)
            {
                if(message.resp == "FAIL")
                {
                    if (confirm('Overwrite?'))
                    {
                        message.force=true;
                        console.log("Sending: " + JSON.stringify(message));
                        ws_storage.send(JSON.stringify(message));
                    }
                    else
                    {
                        //do nothing
                    }
                }

                return;
            }

            //the message is an array of profiles
            //FIXME: this should be better, maybe a {"profiles": ...} container?
            profiles = message;
            //delete old options in select
            $('#e2').find('option').remove().end();
            // check if current selected value is a valid profile name
            // if not, update with first available profile name
            var valid_profile_names = profiles.map(function(a) {return a.name;});
            if (
              valid_profile_names.length > 0 &&
              $.inArray(selected_profile_name, valid_profile_names) === -1
            ) {
              selected_profile = 0;
              selected_profile_name = valid_profile_names[0];
            }

            // fill select with new options from websocket
            for (var i=0; i<profiles.length; i++)
            {
                var profile = profiles[i];
                //console.log(profile.name);
                $('#e2').append('<option value="'+i+'">'+profile.name+'</option>');

                if (profile.name == selected_profile_name)
                {
                    selected_profile = i;
                    $('#e2').select2('val', i);
                    updateProfile(i);
                }
            }
        };


        $("#e2").select2(
        {
            placeholder: "Select Profile",
            allowClear: true,
            minimumResultsForSearch: -1
        });


        $("#e2").on("change", function(e)
        {
            updateProfile(e.val);
        });

        // click a segment on the graph to unlock just that one for editing
        // (only while a run is active and editing has been armed via Edit)
        $("#graph_container").bind("plotclick", function(event, pos, item)
        {
            if (!segments_armed || state != "RUNNING") return;
            if (pos == null || pos.x == null) return;
            var seg = segmentAtTime(pos.x);
            if (seg >= 0) selectSegment(seg);
        });

    }
});
