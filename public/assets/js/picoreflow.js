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
var graph_start_ms = null;        // wall-clock (ms) corresponding to runtime=0, for clock-time axis
var graph_projection = [];        // [runtime, temp] waypoints for the estimated remaining schedule (live only)

// profile editor (rate/temp/hold) buffer. Each segment is {rate: deg/hr,
// target: deg, hold: seconds}, matching deriveSegments/segmentsToPoints.
var edit_segments = [];
var edit_start_temp = 100;        // ambient the first ramp starts from (editable)

var protocol = 'ws:';
if (window.location.protocol == 'https:') {
    protocol = 'wss:';
}
var host = "" + protocol + "//" + window.location.hostname + ":" + window.location.port;
// sockets are created (and re-created on disconnect) in document.ready
var ws_status, ws_control, ws_config, ws_storage;


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
    // Only paint when the flot panel is actually on screen; the panel is hidden
    // on load until we know the state (showIdlePanel replots on reveal), so a
    // RUNNING refresh never flashes the default profile.
    if ($("#graph_container").is(":visible"))
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

// wall-clock time like "3:45 PM"
function clockTime(date)
{
    return date.toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'});
}

// A firing can run past midnight, so a bare clock time ("5:22 AM") is ambiguous.
// Return the day relative to now: "" today, "Tomorrow", a weekday within a week,
// else a short date. Compared on calendar days (not 24h spans).
function dayLabel(date)
{
    var now = new Date();
    var d0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var d1 = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    var days = Math.round((d1 - d0) / 86400000);
    if (days <= 0) return '';
    if (days === 1) return 'Tomorrow';
    if (days < 7) return date.toLocaleDateString([], {weekday: 'long'});
    return date.toLocaleDateString([], {month: 'short', day: 'numeric'});
}

// "5:22 AM" today, "5:22 AM Tomorrow" / "5:22 AM Monday" on later days (inline)
function clockTimeDay(date)
{
    var d = dayLabel(date);
    return clockTime(date) + (d ? ' ' + d : '');
}

// same, but the day drops to a second line (for the tight progress ring)
function clockTimeDayBr(date)
{
    var d = dayLabel(date);
    return clockTime(date) + (d ? '<br>' + d : '');
}

// countdown like "1:23:45" or "12:30"
function hms(seconds)
{
    seconds = Math.max(0, parseInt(seconds) || 0);
    var h = Math.floor(seconds / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    var s = seconds % 60;
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return h > 0 ? (h + ':' + p(m) + ':' + p(s)) : (m + ':' + p(s));
}

function setStateWord(word, cls)
{
    $('#state').removeClass('running holding waiting error').addClass(cls || '').html(word);
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
    $('#e2').val(0);
    graph.profile.points.show = false;
    graph.profile.draggable = false;
    graph.plot = $.plot("#graph_container", [ graph.profile, graph.live ], getOptions());
}


// drive the radial progress ring (circumference of r=52 is 2*pi*52)
function updateProgress(percentage)
{
    var pct = percentage;
    if (isNaN(pct) || pct < 0) pct = 0;
    if (pct > 100) pct = 100;
    var C = 326.726;
    $('#progress_ring').css('stroke-dashoffset', C * (1 - pct / 100));
    $('#progress_pct').html(Math.round(pct) + '%');
}

// Parse a free-text hold duration into seconds. Accepts "45m", "3.5h",
// "3h 30m", "90m" or a bare number (treated as minutes). Case/space tolerant;
// unparseable input -> 0.
function parseHold(text)
{
    if (text === null || text === undefined) return 0;
    var s = ("" + text).toLowerCase().trim();
    if (s === "") return 0;
    var secs = 0;
    var matched = false;
    var re = /([0-9]*\.?[0-9]+)\s*([hm])/g;
    var m;
    while ((m = re.exec(s)) !== null) {
        matched = true;
        var val = parseFloat(m[1]);
        secs += (m[2] === "h") ? val * 3600 : val * 60;
    }
    if (!matched) {
        // bare number -> minutes
        var n = parseFloat(s);
        if (!isNaN(n)) secs = n * 60;
    }
    return secs;
}

// Render seconds as a canonical "Xh Ym" hold string (0 -> "0m").
function formatHold(seconds)
{
    var mins = Math.round((seconds || 0) / 60);
    var h = Math.floor(mins / 60);
    var m = mins % 60;
    if (h > 0 && m > 0) return h + "h " + m + "m";
    if (h > 0) return h + "h";
    return m + "m";
}

// Recompute the ideal curve from the edit buffer and redraw the graph.
function refreshEditGraph()
{
    graph.profile.data = segmentsToPoints(edit_segments, edit_start_temp);
    graph.plot = $.plot("#graph_container", [ graph.profile, graph.live ], getOptions());
}

// Rate/temp/hold segment editor. Renders the edit buffer (edit_segments +
// edit_start_temp) as an editable table and keeps the graph in sync.
function updateProfileTable()
{
    var iconBtn = function(action, glyph, tip){ return '<button type="button" class="btn btn-link btn-xs seg-action" onclick="'+action+'" title="'+tip+'"><span class="glyphicon glyphicon-'+glyph+'"></span></button>'; };
    var addBtn = function(pos){ return iconBtn('insertSegment('+pos+')', 'plus', 'Add segment below'); };

    var html = '<h4 style="margin-top:0">Segments</h4>';
    html += '<div class="table-responsive"><table class="table table-condensed" style="margin-bottom:0">';
    html += '<tr><th style="width:44px">#</th><th>Rate &deg;'+temp_scale_display+'/hr</th><th>Target &deg;'+temp_scale_display+'</th><th>Hold</th><th style="width:64px"></th></tr>';

    // Start temp is row 0; its "Add below" inserts a segment at the top.
    html += '<tr class="active"><td><small>Start</small></td>';
    html += '<td class="text-muted">&mdash;</td>';
    html += '<td><input type="number" class="form-control input-sm" id="seg-start" value="'+ Math.round(edit_start_temp) +'" style="width:80px" /></td>';
    html += '<td class="text-muted">&mdash;</td>';
    html += '<td style="white-space:nowrap">'+ addBtn(0) +'</td></tr>';

    for(var i=0; i<edit_segments.length; i++)
    {
        var s = edit_segments[i];
        html += '<tr><td>' + (i+1) + '</td>';
        html += '<td><input type="number" min="0" class="form-control input-sm" id="segrow-rate-'+i+'" value="'+ Math.round(s.rate) +'" style="width:80px" /></td>';
        html += '<td><input type="number" class="form-control input-sm" id="segrow-target-'+i+'" value="'+ Math.round(s.target) +'" style="width:80px" /></td>';
        html += '<td><input type="text" class="form-control input-sm" id="segrow-hold-'+i+'" value="'+ formatHold(s.hold) +'" style="width:90px" title="e.g. 45m, 3.5h, 3h 30m" /></td>';
        html += '<td style="white-space:nowrap">'+ addBtn(i+1) + iconBtn('deleteSegment('+i+')', 'trash', 'Delete segment') +'</td></tr>';
    }

    html += '</table></div>';

    $('#profile_table').html(html);

    // Start temp
    $('#seg-start').change(function()
    {
        var v = parseFloat($(this).val());
        if (!isNaN(v)) edit_start_temp = v;
        refreshEditGraph();
        updateProfileTable();
    });

    // Segment fields -> edit buffer -> graph
    $('#profile_table [id^="segrow-"]').change(function()
    {
        var fields = $(this)[0].id.split("-");  // segrow-<field>-<row>
        var field = fields[1];
        var row = parseInt(fields[2]);
        if (row < 0 || row >= edit_segments.length) return;

        if (field === "hold") {
            edit_segments[row].hold = parseHold($(this).val());
        } else {
            var v = parseFloat($(this).val());
            if (!isNaN(v)) edit_segments[row][field] = v;
        }

        refreshEditGraph();
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

// x-axis as wall-clock time. graph_start_ms is the clock time at runtime=0
// (set when a run starts); when idle we anchor at "now" so a preview reads
// as if it started now.
function timeTickFormatter(val, axis)
{
    var base = graph_start_ms || Date.now();
    var d = new Date(base + val * 1000);
    var h = d.getHours(), m = d.getMinutes();
    var ampm = h < 12 ? 'AM' : 'PM';
    var h12 = h % 12 || 12;
    // omit ":00" on the hour to keep labels short on narrow screens
    return (m === 0) ? (h12 + ' ' + ampm) : (h12 + ':' + (m < 10 ? '0' : '') + m + ' ' + ampm);
}

// place x-axis ticks on clean clock boundaries (:00/:15/:30/:45, or whole
// hours for longer firings) instead of arbitrary offsets from the start time
function clockTickGenerator(axis)
{
    var base = graph_start_ms || Date.now();
    var span = axis.max - axis.min;                 // seconds visible
    var steps = [900, 1800, 3600, 7200, 10800, 21600, 43200, 86400]; // 15m..24h
    // fewer ticks on a phone so the clock labels don't crowd/overlap
    var want = (window.innerWidth && window.innerWidth < 720) ? 4 : 6;
    var step = steps[steps.length - 1];
    for (var i = 0; i < steps.length; i++) {
        if (steps[i] >= span / want) { step = steps[i]; break; }
    }
    var stepMs = step * 1000;
    // align to LOCAL clock boundaries (from local midnight, not the UTC epoch) so
    // multi-hour steps land on round hours (12/3/6/9…) instead of odd offsets that
    // depend on the timezone
    var bd = new Date(base + axis.min * 1000);
    var midMs = new Date(bd.getFullYear(), bd.getMonth(), bd.getDate(), 0, 0, 0, 0).getTime();
    var firstMs = midMs + Math.ceil((base + axis.min * 1000 - midMs) / stepMs) * stepMs;
    var ticks = [];
    for (var t = firstMs; t <= base + axis.max * 1000; t += stepMs) {
        ticks.push((t - base) / 1000);              // back to runtime seconds
    }
    return ticks;
}

function runTask()
{
    // resume the previous firing: keep the existing red trace and let the
    // server pick up where it stopped (profile + runtime come from the
    // server's resume snapshot, so the dropdown selection is ignored)
    if ($('#resume_enable').is(':checked')) {
        ws_control.send(JSON.stringify({"cmd": "RUN", "resume": true}));
        return;
    }

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

function toggleResume()
{
    // resuming uses the previous firing as-is, so hide the aim options
    if ($('#resume_enable').is(':checked')) {
        $('#aim_enable').prop('checked', false);
        $('#aim_fields').hide();
        $('#aim_row').hide();
    } else {
        $('#aim_row').show();
    }
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

// generic confirmation modal: runs cb only if the user confirms
var _confirm_cb = null;
function confirmAction(title, body, okLabel, okClass, cb)
{
    $('#confirmModalTitle').text(title);
    $('#confirmModalBody').text(body);
    $('#confirmModalOk').text(okLabel)
        .removeClass('btn-danger btn-warning btn-success btn-default')
        .addClass(okClass);
    _confirm_cb = cb;
    $('#confirmModal').modal('show');
}

function confirmStop()
{
    confirmAction('Stop the firing?',
        'This aborts the current firing immediately and the kiln stops heating. This cannot be undone.',
        'Stop firing', 'btn-danger', abortTask);
}

function confirmAdvance()
{
    confirmAction('Skip to the next segment?',
        'This ends the current segment now and starts the next one. This cannot be undone.',
        'Advance', 'btn-warning', advanceSegment);
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
    var html = '<h4 style="margin-top:0">Segments <small>tap a row, then edit its target or hold</small></h4>';
    html += '<div class="table-responsive"><table class="table table-condensed" style="margin-bottom:0">';
    html += '<tr><th style="width:40px">#</th><th>Rate &deg;'+temp_scale_display+'/hr</th><th>Target &deg;'+temp_scale_display+'</th><th>Hold (min)</th></tr>';
    for (var i=0; i<segments.length; i++)
    {
        var s = segments[i];
        var cls = (i === active) ? ' class="info"' : '';
        html += '<tr'+cls+' onclick="selectSegment('+i+')" style="cursor:pointer">'+'<td>'+(i+1)+'</td>';
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

var controller_name = "";

// show the controller's human name in the header; keep the edit field in sync
function setControllerName(name)
{
    controller_name = name;
    $('#controller_name').text(name);
    document.title = name + " — Kiln Controller";
}

// switch the header into inline-edit mode
function editControllerName()
{
    $('#controller_name_input').val(controller_name);
    $('#controller_name').hide();
    $('#controller_name_edit').show();
    $('#controller_name_input').focus().select();
}

function cancelControllerName()
{
    $('#controller_name_edit').hide();
    $('#controller_name').show();
}

// persist the new name via the REST /api endpoint, then update the header
function saveControllerName()
{
    var name = $.trim($('#controller_name_input').val());
    if (name === "") { return; }
    $.ajax({
        url: "/api",
        type: "POST",
        contentType: "application/json",
        data: JSON.stringify({"cmd": "set_controller_name", "name": name}),
        success: function(resp) {
            if (resp && resp.success) {
                setControllerName(resp.name);
                cancelControllerName();
            } else {
                $.bootstrapGrowl((resp && resp.error) || "Could not rename controller", {type: "danger"});
            }
        },
        error: function() {
            $.bootstrapGrowl("Could not reach the controller to rename it", {type: "danger"});
        }
    });
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
    graph.profile.draggable = false;
    edit_start_temp = 100;
    edit_segments = [{rate: 100, target: 200, hold: 0}];
    refreshEditGraph();
    updateProfileTable();
    $('#profile_table').show();
}

function enterEditMode()
{
    state="EDIT"
    $('#status').slideUp();
    $('#edit').show();
    $('#profile_selector').hide();
    $('#btn_controls').hide();
    $('#form_profile_name').val(profiles[selected_profile].name);
    graph.profile.points.show = true;
    graph.profile.draggable = false;
    edit_segments = deriveSegments(profiles[selected_profile]);
    var d = profiles[selected_profile].data;
    edit_start_temp = (d && d.length) ? d[0][1] : 100;
    refreshEditGraph();
    updateProfileTable();
    $('#profile_table').show();
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

// Insert a new segment at position `pos` (0 = top). Default its target a bit
// above whatever comes before it so the curve stays sensible until edited.
function insertSegment(pos)
{
    if (pos < 0) pos = 0;
    if (pos > edit_segments.length) pos = edit_segments.length;
    var prev = (pos > 0) ? edit_segments[pos-1].target : edit_start_temp;
    edit_segments.splice(pos, 0, {rate: 100, target: prev + 100, hold: 0});
    refreshEditGraph();
    updateProfileTable();
}

function deleteSegment(i)
{
    if (i < 0 || i >= edit_segments.length) return;
    edit_segments.splice(i, 1);
    refreshEditGraph();
    updateProfileTable();
}


function saveProfile()
{
    name = $('#form_profile_name').val();

    // rate/temp/hold is the source of truth; the time/temp `data` curve is
    // derived so the graph and the server agree on what will run.
    var rth = edit_segments.map(function(s){
        return [Math.round(s.rate), Math.round(s.target), s.hold / 3600];
    });
    var data = segmentsToPoints(edit_segments, edit_start_temp);

    var profile = { "type": "profile", "rth": rth, "data": data, "name": name }
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
      ticks: clockTickGenerator,
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
    // report.html reuses this file's render functions but has no dashboard;
    // skip the live-dashboard init (websockets, flot) when it isn't present
    if(!document.getElementById("graph_container")) return;

    if(!("WebSocket" in window))
    {
        $('#chatLog, input, button, #examples').fadeOut("fast");
        $('<p>Oh no, you need a browser that supports WebSockets. How about <a href="http://www.google.com/chrome">Google Chrome</a>?</p>').appendTo('#container');
    }
    else
    {

        // Connection state / reconnect handling ////////////
        //
        // All four sockets drop together when the service restarts. Show a
        // persistent "disconnected" banner (driven by the status socket, the
        // live heartbeat) and keep recreating any closed socket every few
        // seconds until the service comes back.

        var _reconnect_timer = null;
        var _authExpired = false;

        function setConnected(connected)
        {
            if (connected)
            {
                _authExpired = false;
                $('#conn_banner').hide();
                $('#auth_banner').hide();
            }
            else
            {
                // A dropped status socket can mean the backend restarted OR the
                // Cloudflare Access session expired. A failed WS handshake hides
                // its HTTP status from JS, so the socket alone can't tell us
                // which. Show the generic "reconnecting" banner now, then probe a
                // cheap GET (whose status we *can* read) to detect the auth case
                // and swap in the "please re-login" banner instead.
                if (!_authExpired) { $('#conn_banner').show(); }
                probeAuth();
            }
        }

        // Distinguish "backend/tunnel down" from "Cloudflare Access session
        // expired". fetch() exposes the HTTP status the WebSocket handshake
        // won't: Access returns 401/403 (or 302-redirects to its login) once the
        // access cookie lapses, while a live-but-restarting backend answers 200.
        function probeAuth()
        {
            fetch("/api/stats", { cache: "no-store", credentials: "same-origin", redirect: "manual" })
                .then(function(r)
                {
                    // The status socket may have reconnected while this was in
                    // flight; if so, setConnected(true) already fixed the banners.
                    if (ws_status && ws_status.readyState === 1) { return; }

                    if (r.status === 401 || r.status === 403 || r.type === "opaqueredirect")
                    {
                        _authExpired = true;
                        $('#conn_banner').hide();
                        $('#auth_banner').show();
                    }
                    else
                    {
                        // Reachable and authorized: the drop is a backend/tunnel
                        // blip, not an auth problem. Keep the generic banner.
                        _authExpired = false;
                        $('#auth_banner').hide();
                        $('#conn_banner').show();
                    }
                })
                .catch(function()
                {
                    // Network error (backend/tunnel truly unreachable): leave the
                    // generic reconnecting banner up.
                });
        }

        function scheduleReconnect()
        {
            // Note: the banner is driven solely by the status socket (see
            // setupStatusSocket) — the live heartbeat. The config/control/storage
            // sockets go idle after their initial GET and get dropped by the
            // Cloudflare tunnel's websocket idle timeout; those closes should
            // silently reconnect without flagging the whole UI as disconnected.
            if (_reconnect_timer) { return; }   // a retry is already pending
            _reconnect_timer = setTimeout(function()
            {
                _reconnect_timer = null;
                // readyState: 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED
                if (!ws_status  || ws_status.readyState  > 1) { setupStatusSocket();  }
                if (!ws_config  || ws_config.readyState  > 1) { setupConfigSocket();  }
                if (!ws_control || ws_control.readyState > 1) { setupControlSocket(); }
                if (!ws_storage || ws_storage.readyState > 1) { setupStorageSocket(); }
            }, 2000);
        }

        // Status Socket ////////////////////////////////

        function setupStatusSocket()
        {
            ws_status = new WebSocket(host + "/status");

            ws_status.onopen = function()
            {
                console.log("Status Socket has been opened");
                setConnected(true);
            };

            ws_status.onerror = function()
            {
                try { ws_status.close(); } catch (err) {}
            };

            ws_status.onclose = function()
            {
                console.log("Status Socket closed - will retry");
                setConnected(false);
                scheduleReconnect();
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
                            $('#e2').val(i);
                        }
                    });
                }

                // The backlog is the server's complete firing log, so replace the
                // live buffer rather than appending — on a websocket reconnect
                // graph.live.data already holds the accumulated stream points, and
                // appending the full backlog (which also starts at runtime 0) would
                // re-trace the whole firing from the origin (the spurious line back
                // to the start point). Replacing keeps the curve correct without a
                // page refresh.
                graph.live.data = (x.log || []).map(function(v){ return [v.runtime, v.temperature]; });
                if ($("#graph_container").is(":visible"))
                    graph.plot = $.plot("#graph_container", [ graph.profile, graph.live ] , getOptions());
                // redraw the live-detail canvas too, if it's the visible view
                if (typeof histBuildCurveLive === "function" && histDetail && $("#live_detail").is(":visible")) {
                    histBuildCurveLive();
                    if (document.getElementById("hist_graph")) histDrawGraph();
                }
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
                            // normal completion or Stop: just reset the readouts,
                            // no popup (only errors notify)
                            $('#target_temp').html('---');
                            updateProgress(0);
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

                    // keep the segment editor populated, but it stays hidden
                    // behind the "Edit schedule" toggle in the live detail (#3)
                    manageSegmentEditor(x);

                    if (graph_start_ms === null) graph_start_ms = Date.now() - x.runtime * 1000;
                    graph.live.data.push([x.runtime, x.temperature]);
                    // estimated remaining schedule (gray dotted) from the current state
                    graph_projection = buildProjection(x);
                    // flot is the idle/preview graph; while a firing is active the
                    // unified live detail (canvas) is shown instead, so only replot
                    // flot when it's actually visible (replotting a hidden/zero-size
                    // container throws)
                    if ($("#graph_container").is(":visible"))
                        graph.plot = $.plot("#graph_container", [ graph.profile, graph.live ] , getOptions());

                    setStateWord(manual_hold ? "HOLDING" : "RUNNING", manual_hold ? "holding" : "running");
                    updateProgress(parseFloat(x.runtime) / parseFloat(x.totaltime) * 100);

                    // completion clock = run start + total (sim) duration. Anchored
                    // to graph_start_ms (the wall-clock at runtime=0) so it reads as a
                    // fixed wall-clock time and doesn't count down when the sim runs fast.
                    $('#eta_complete').html('done ' + clockTimeDayBr(new Date(graph_start_ms + x.totaltime * 1000)));

                    // current segment, with both the ramp-reaches-temp ETA and
                    // the hold-ends ETA as fixed clock times
                    if (x.segments && x.segment !== null && x.segment < x.segments.length
                        && x.segment_remaining !== null && x.segment_remaining !== undefined) {
                        var seg = x.segments[x.segment];
                        $('#seg_info').html('Seg ' + (x.segment + 1) + ' &middot; ' + Math.round(seg.target) + '&deg;' + temp_scale_display);
                        // during a ramp, segment_remaining = (time to target) + full hold
                        var rampRem = (x.phase === 'RAMP') ? Math.max(0, x.segment_remaining - seg.hold) : 0;
                        var rampEta = clockTimeDay(new Date(graph_start_ms + (x.runtime + rampRem) * 1000));
                        var holdEta = clockTimeDay(new Date(graph_start_ms + (x.runtime + x.segment_remaining) * 1000));
                        var txt;
                        if (x.phase === 'RAMP') {
                            txt = 'eta ' + rampEta;
                            if (seg.hold > 0) txt += ', hold until ' + holdEta;
                        } else {
                            // at temperature, soaking
                            txt = (x.segment_remaining > 0.5) ? 'hold until ' + holdEta : 'complete';
                        }
                        $('#seg_eta').html(txt);
                    } else { $('#seg_info').html(''); $('#seg_eta').html(''); }

                    $('#target_temp').html(parseInt(x.target));
                  


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
                    setStateWord("WAITING", "waiting");
                    graph_projection = [];
                    updateProgress(0);
                    $('#progress_pct').html(hms(x.wait_remaining));
                    $('#eta_complete').html('until start');
                    $('#seg_info').html('');
                    $('#seg_eta').html('');
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
                    graph_start_ms = null;      // idle preview anchors at "now"
                    graph_projection = [];
                    var isErr = (typeof state === 'string' && state.indexOf('ERROR') !== -1);
                    setStateWord(state, isErr ? 'error' : '');
                    updateProgress(0);
                    $('#progress_pct').html('&mdash;');
                    $('#eta_complete').html('');
                    $('#seg_info').html('');
                    $('#seg_eta').html('');
                }

                if (x.watcher_alarm) { $('#watcher_alarm').show(); } else { $('#watcher_alarm').hide(); }

                // offer resume of a stopped/failed firing on the Start dialog
                if (x.resume_available) {
                    $('#resume_row').show();
                    $('#resume_label').text('Resume previous firing — ' + x.resume_profile + ' at ' + hms(x.resume_runtime));
                } else {
                    $('#resume_row').hide();
                    $('#resume_enable').prop('checked', false);
                }

                $('#act_temp').html(parseInt(x.temperature));
                // heating indicator: glow the temp card + show the pill
                if (x.heat > 0 || (x.pidstats && x.pidstats.out > 0.02)) {
                    $('#heat').addClass('on'); $('#temp_card').addClass('heating');
                } else {
                    $('#heat').removeClass('on'); $('#temp_card').removeClass('heating');
                }

                updateLiveView(x);
                histLiveTick();   // redraw the live detail's actual curve from this status point
                state_last = state;

            }
        };
        }   // end setupStatusSocket

        // Config Socket /////////////////////////////////

        function setupConfigSocket()
        {
            ws_config = new WebSocket(host + "/config");

            ws_config.onclose = function() { scheduleReconnect(); };

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

            if (x.controller_name) { setControllerName(x.controller_name); }

            if (temp_scale == "c") {temp_scale_display = "C";} else {temp_scale_display = "F";}

            // if the history view rendered before the scale arrived (e.g. a cold
            // #history deep-link), re-render it now with the right unit
            if ($("#history_view").is(":visible") && histList) {
                renderHistList(histDetail ? histDetail.id : null);
                if (histDetail) renderHistDetail(histDetail);
            }

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
        }   // end setupConfigSocket

        // Control Socket ////////////////////////////////

        function setupControlSocket()
        {
            ws_control = new WebSocket(host + "/control");

            ws_control.onclose = function() { scheduleReconnect(); };

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
            if ($("#graph_container").is(":visible"))
                graph.plot = $.plot("#graph_container", [ graph.profile, graph.live ] , getOptions());

        }
        }   // end setupControlSocket

        // Storage Socket ///////////////////////////////

        function setupStorageSocket()
        {
            ws_storage = new WebSocket(host + "/storage");

            ws_storage.onclose = function() { scheduleReconnect(); };

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
            // sort the dropdown case-insensitively by name (indices below are
            // derived from this sorted array, so they stay consistent)
            profiles.sort(function(a,b){ return (a.name||"").toLowerCase().localeCompare((b.name||"").toLowerCase()); });
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
                    $('#e2').val(i);
                    updateProfile(i);
                }
            }
        };
        }   // end setupStorageSocket

        // Open all four sockets now. Each recreates itself (via
        // scheduleReconnect) if it drops, so a service restart is recovered
        // automatically and the disconnected banner clears on reconnect.
        setupStatusSocket();
        setupConfigSocket();
        setupControlSocket();
        setupStorageSocket();

        loadMru();   // recent-firings quick pick in the idle view

        // native <select> (no select2): on iOS it uses the native picker
        // instead of popping the keyboard, and styles cleanly
        $("#e2").on("change", function()
        {
            updateProfile($(this).val());
        });

        // confirmation modal: run the stashed callback when OK is clicked
        $("#confirmModalOk").on("click", function()
        {
            var cb = _confirm_cb;
            _confirm_cb = null;
            if (cb) cb();
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


/* =======================================================================
   Firing history (Phase 5)
   Lists past firings from /api/firings and shows a detail view: a
   planned-vs-actual canvas graph, an event timeline linked to the graph,
   and read-only firing notes. Ported from the design prototype.
   ======================================================================= */
var histList = null;     // list summaries
var histDetail = null;   // currently loaded full record
var histCurve = null;    // {act, plan, events, bands, xmax, ymax}
var histSel = null;      // selected event index (links list <-> graph)
var histPins = [];        // {x, idx} graph pin hit-targets
var histRating = null;   // editable notes state for the open firing
var histEditTags = [];
var histEditDefects = [];
var histPhotoPins = [];  // {x, photo} graph camera-marker hit-targets
var histNotePins = [];   // {x, note} graph note-marker hit-targets
var liveRuntime = 0;     // latest firing-clock seconds from /status (for photo capture-time)
var liveFiringId = null; // active firing's bundle id, while a firing is in progress
var livePollTimer = null;

function histTU(){ return "°" + (typeof temp_scale_display !== "undefined" ? temp_scale_display : "F"); }
function histEsc(s){ return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function histFmtDur(sec){
  sec=Math.max(0,Math.round(sec)); var h=Math.floor(sec/3600), m=Math.round((sec%3600)/60);
  return h>=1 ? (h+"h "+(m<10?"0":"")+m+"m") : (m+"m");
}
function histFmtClock(sec){ var h=Math.floor(sec/3600), m=Math.round((sec%3600)/60); return h+":"+(m<10?"0":"")+m; }
// short wall-clock label for a graph tick, e.g. "6 AM" on the hour, "6:30 AM" off it
function histClockShort(date){
  var h=date.getHours(), m=date.getMinutes(), ap=h<12?"AM":"PM", h12=h%12||12;
  return m===0 ? (h12+" "+ap) : (h12+":"+(m<10?"0":"")+m+" "+ap);
}
// x-axis tick runtimes (seconds from start) aligned to clean LOCAL clock
// boundaries — whole hours for anything but very short firings — so the labels
// read as round clock times (12/3/6/9…) instead of odd offsets from the start.
// `startMs` is the wall-clock at runtime=0; `span`/return are in seconds.
function histClockTicks(startMs, span, want){
  var steps=[900,1800,3600,7200,10800,14400,21600,43200,86400]; // 15m,30m,1h,2h,3h,4h,6h,12h,24h
  var step=steps[steps.length-1];
  for(var i=0;i<steps.length;i++){ if(steps[i] >= span/Math.max(1,want)){ step=steps[i]; break; } }
  var stepMs=step*1000, d=new Date(startMs);
  var midMs=new Date(d.getFullYear(),d.getMonth(),d.getDate(),0,0,0,0).getTime(); // local midnight of start day
  var firstMs=midMs+Math.ceil((startMs-midMs)/stepMs)*stepMs;                     // first boundary >= start
  var ticks=[], endMs=startMs+span*1000;
  for(var t=firstMs; t<=endMs+1; t+=stepMs){ ticks.push((t-startMs)/1000); }
  return ticks;
}
function histFmtDate(iso){
  if(!iso) return "—";
  var d=new Date(String(iso).replace("Z","")); if(isNaN(d)) return iso;
  return d.toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"})+" · "+
         d.toLocaleTimeString(undefined,{hour:"numeric",minute:"2-digit"});
}

var HIST_EV = {
  started:{c:"var(--accent)",i:"▶",t:function(e){return ["Firing started", e.detail&&e.detail.fragments>1?("reassembled from "+e.detail.fragments+" log fragments"):(e.detail&&e.detail.profile||"")];}},
  completed:{c:"var(--accent)",i:"✓",t:function(){return ["Completed",""];}},
  aborted:{c:"#6b7280",i:"■",t:function(){return ["Stopped",""];}},
  interrupted:{c:"var(--warn)",i:"!",t:function(){return ["Interrupted",""];}},
  error:{c:"var(--danger)",i:"✕",t:function(){return ["Error",""];}},
  hold:{c:"var(--warn)",i:"❚❚",t:function(e){return ["Hold engaged", e.detail&&e.detail.setpoint?("setpoint "+Math.round(e.detail.setpoint)+histTU()):""];}},
  hold_release:{c:"var(--warn)",i:"▷",t:function(){return ["Hold released",""];}},
  advance:{c:"var(--info)",i:"»",t:function(e){return ["Advanced segment", e.detail?("segment "+e.detail.from_segment+" → "+e.detail.to_segment):""];}},
  segment_target_edit:{c:"var(--info)",i:"✎",t:function(e){return ["Target edited", e.detail?("seg "+e.detail.segment+": "+Math.round(e.detail.old)+" → "+Math.round(e.detail.new)+histTU()):""];}},
  segment_hold_edit:{c:"var(--info)",i:"✎",t:function(e){return ["Hold edited", e.detail?("seg "+e.detail.segment+": "+Math.round(e.detail.new/60)+" min"):""];}},
  segment_transition:{c:"#9aa3b2",i:"·",t:function(e){return ["Segment "+(e.detail?e.detail.segment:""), e.detail?e.detail.phase:""];}},
  power_interruption:{c:"var(--danger)",i:"⚡",t:function(){return ["Power interrupted",""];}},
  resumed:{c:"var(--info)",i:"↻",t:function(e){return ["Resumed", e.detail&&e.detail.gap_s?("after "+histFmtDur(e.detail.gap_s)):(e.detail&&e.detail.from_status?("from "+e.detail.from_status):"")];}}
};

// Rich label for a segment_transition, using the profile-derived segments so a
// ramp shows its rate + destination temp and a hold shows its temp + duration.
// `segs` come from deriveSegments(profile); falls back to the bare phase.
function histSegText(e, segs){
  var det=e.detail||{}, phase=det.phase;
  var title="Segment "+((typeof det.segment==="number")?(det.segment+1):"");
  var seg=segs&&segs[det.segment];
  if(!seg) return [title, phase||""];
  if(phase==="HOLD"){
    return [title, "hold "+Math.round(seg.target)+histTU()+(seg.hold>0?(" for "+histFmtDur(seg.hold)):"")];
  }
  return [title, "ramp to "+Math.round(seg.target)+histTU()+(seg.rate>0?(" at "+Math.round(seg.rate)+histTU()+"/hr"):"")];
}

function toggleHistory(){ if($("#history_view").is(":visible")) showLive(); else showHistory(); }
function showHistory(){ $("#live_view").hide(); $("#live_detail_body").empty(); $("#history_view").show().removeClass("detail-open"); loadFiringList();
  $("#nav_history").html('<span class="glyphicon glyphicon-chevron-left"></span> Live dashboard');
  if(window.history&&history.replaceState) history.replaceState(null,"","#history"); }
function showLive(){ $("#history_view").hide(); $("#live_view").show();
  $("#nav_history").html('<span class="glyphicon glyphicon-time"></span> History');
  if(liveFiringId){ enterLiveDetail(liveFiringId); }
  else { $("#live_view > .panel").show();
         graph.plot = $.plot("#graph_container", [ graph.profile, graph.live ], getOptions());
         $(window).trigger("resize"); }
  if(window.history&&history.replaceState) history.replaceState(null,"",location.pathname+location.search); }
function histBackToList(){ $("#history_view").removeClass("detail-open"); }

function loadFiringList(){
  $("#hist_list").html('<div class="hist-empty">Loading…</div>'); $("#hist_main").html("");
  $.getJSON("/api/firings").done(function(list){
    histList = list || [];
    if(!histList.length){ $("#hist_list").html(""); $("#hist_main").html('<div class="hist-empty">No firings recorded yet.</div>'); return; }
    $("#history_view").removeClass("detail-open");
    renderHistList(null);
    // desktop shows both panes, so preload the newest firing; on mobile we stay
    // on the list until the user taps one (master-detail)
    if(window.innerWidth>900) loadFiring(histList[0].id); else $("#hist_main").html("");
  }).fail(function(){ $("#hist_list").html('<div class="hist-empty">Could not load firing history.</div>'); });
}

function renderHistList(selId){
  var html="";
  histList.forEach(function(f){
    var s=f.summary||{};
    html += '<button type="button" class="firing-card'+(f.id===selId?" sel":"")+'" onclick="loadFiring(\''+f.id+'\')">'+
      '<div class="fc-top"><span class="fc-date tnum">'+histFmtDate(s.started_at)+'</span>'+
      '<span class="pill '+(s.status||"")+'">'+(s.status||"")+'</span></div>'+
      '<div class="fc-name">'+histEsc(f.title||f.profile_name||"—")+'</div>'+
      '<div class="fc-meta tnum"><span><b>'+Math.round(s.max_temp||0)+'</b>'+histTU()+'</span>'+
      '<span><b>'+histFmtDur(s.duration_s||0)+'</b></span></div></button>';
  });
  $("#hist_list").html(html);
}

function loadFiring(id){
  $("#history_view").addClass("detail-open");   // mobile: switch to the detail screen
  renderHistList(id);
  $("#hist_main").html('<div class="hist-empty">Loading firing…</div>');
  $.getJSON("/api/firings/"+encodeURIComponent(id)+"?resolution=800").done(function(d){
    histDetail=d; histSel=null; renderHistDetail(d);
  }).fail(function(){ $("#hist_main").html('<div class="hist-empty">Could not load this firing.</div>'); });
}

function histStat(label,val,unit,accent){
  return '<div class="stat'+(accent?" accent":"")+'"><div class="s-label">'+label+'</div>'+
    '<div class="s-val">'+val+(unit?'<span class="u">'+unit+'</span>':'')+'</div></div>';
}

function histStatsHtml(s){
  var peak = s.peak_target!=null?Math.round(s.peak_target):"—";
  return histStat("Max temp", Math.round(s.max_temp||0), histTU(), true)+
    histStat("Peak target", peak, histTU())+
    histStat("Duration", histFmtDur(s.duration_s||0), "");
}

// target: "#hist_main" (history) or "#live_detail_body" (in-progress firing)
function renderHistDetail(d, target){
  target = target || "#hist_main";
  var live = (target === "#live_detail_body");
  var s=d.summary||{};
  var m=d.metadata||{}; var o=m.outcome||{};
  // a custom title (if set) acts as the firing's display name; the profile name
  // becomes secondary context
  var heading = m.title || d.profile.name;
  // seed the editable-notes state for this firing
  histRating = o.rating || null;
  histEditTags = (m.tags||[]).slice();
  histEditDefects = (o.defects||[]).slice();
  var html =
    (live ? "" : '<button type="button" class="hist-back" onclick="histBackToList()"><span class="glyphicon glyphicon-chevron-left"></span> All firings</button>')+
    '<div class="detail-head">'+
      '<h1 class="dh-title"><span class="pill dh-pill '+(s.status||"")+'">'+(s.status||"")+'</span>'+histEsc(heading)+'</h1>'+
      '<div class="dh-sub tnum"><span>'+histFmtDate(s.started_at)+'</span>'+
      (m.title ? '<span class="dh-subname">'+histEsc(d.profile.name)+'</span>' : '')+
      (d.imported?'<span class="tag-imported">imported from log</span>':'')+
      '<a class="report-link" href="/kiln/report.html?id='+encodeURIComponent(d.id)+'&scale='+(typeof temp_scale!=="undefined"?temp_scale:"f")+'" target="_blank"><span class="glyphicon glyphicon-print"></span> Report</a>'+
      '</div></div>'+
    // stats live in the top status card during a firing, so only show the strip
    // for completed firings in history
    (live ? "" : '<div class="stats tnum">'+histStatsHtml(s)+'</div>')+
    // graph + timeline merged into one white card, split by a rule
    '<div class="hist-card">'+
      '<div class="live-editbar">'+
        (live ? '<button type="button" class="btn-edit-sched" id="btn_edit_sched" onclick="toggleLiveSegments()"><span class="glyphicon glyphicon-edit"></span> Edit schedule</button>' : '')+
        '<div class="anno-group">'+
          '<button type="button" class="btn-anno" onclick="histAddNote()">+ Note</button>'+
          '<button type="button" class="btn-anno" onclick="histPhotoPick()">+ Photo</button>'+
          '<input type="file" id="hist_photo_input" accept="image/*" style="display:none" onchange="histUploadPhoto(this)">'+
        '</div>'+
      '</div>'+
      '<div class="card-hd"><h3>Planned vs. actual</h3>'+
      '<div class="legend"><span class="lg"><span class="swatch" style="background:var(--heat)"></span>Actual</span>'+
      '<span class="lg"><span class="swatch dash"></span>Planned</span>'+
      '<span class="lg"><span class="swatch" style="background:var(--danger)"></span>Interruption</span>'+
      '<span class="lg">📷 Photo</span><span class="lg">📝 Note</span></div></div>'+
      '<div class="selcap" id="hist_selcap"></div>'+
      '<div class="graph-wrap"><canvas id="hist_graph"></canvas><div class="hist-tip" id="hist_tip"></div></div>'+
      '<hr class="card-rule">'+
      '<div class="merge-lower">'+
        '<div id="tl_section"><h2>Event timeline</h2><div class="timeline" id="hist_timeline"></div></div>'+
        (live ? '<div id="seg_section" style="display:none"><h2>Schedule — ramp / target / hold</h2><div id="segment_table"></div></div>' : '')+
      '</div>'+
    '</div>'+
    '<div class="hist-card panel-pad notes-card" id="notes_card"><h2>Firing notes</h2>'+renderHistNotes(d)+'</div>';
  $(target).html(html);
  histBuildCurve(d);
  histRenderTimeline(d);
  histDrawGraph();
  histUpdateSelCap();
  histRenderStars(); histRenderTags(); histRenderDefects(); histRenderPhotos(); histRenderNoteList();
}

function renderHistNotes(d){
  var m=d.metadata||{}; var o=m.outcome||{};
  return '<div class="notes">'+
    '<div class="nf"><label>Title</label><input id="nf_title" class="nf-input" maxlength="200" placeholder="e.g. Blue cast — 3 pieces" value="'+histEsc(m.title||"")+'"></div>'+
    '<div class="nf-row">'+
      '<div class="nf"><label>Rating</label><div class="stars" id="nf_stars"></div></div>'+
      '<div class="nf"><label>Tags</label><div class="chips" id="nf_tags"></div></div>'+
    '</div>'+
    '<div class="nf"><label>What happened</label><textarea id="nf_summary" class="nf-area" maxlength="5000" placeholder="Outcome, observations…">'+histEsc(o.summary||"")+'</textarea></div>'+
    '<div class="nf"><label>Defects</label><div class="chips" id="nf_defects"></div></div>'+
    '<div class="nf"><label>Photos</label><div class="photo-grid" id="nf_photos"></div></div>'+
    '<div class="nf"><label>Notes</label><div class="note-list" id="nf_notes"></div></div>'+
    '<div class="nf-actions"><button type="button" class="btn-save" onclick="histSaveNotes()">Save notes</button>'+
      '<span class="nf-hint" id="nf_saved"></span>'+
      '<button type="button" class="btn-del" onclick="histDeleteFiring()">Delete firing</button></div>'+
  '</div>';
}

function histRenderStars(){
  var el=document.getElementById("nf_stars"); if(!el) return;
  var h=""; for(var i=1;i<=5;i++) h+='<span data-n="'+i+'" onclick="histSetRating('+i+')" class="'+(histRating&&i<=histRating?"on":"")+'">★</span>';
  el.innerHTML=h;
}
function histSetRating(n){ histRating=(histRating===n?null:n); histRenderStars(); }

function histRenderTags(){
  var el=document.getElementById("nf_tags"); if(!el) return;
  el.innerHTML = histEditTags.map(function(t,i){ return '<span class="chip">'+histEsc(t)+'<span class="x" onclick="histRemoveTag('+i+')">×</span></span>'; }).join("")+
    '<input class="chip-input" id="nf_tag_input" placeholder="add tag" onkeydown="histChipKey(event,\'tag\')">';
}
function histRenderDefects(){
  var el=document.getElementById("nf_defects"); if(!el) return;
  el.innerHTML = histEditDefects.map(function(t,i){ return '<span class="chip defect">'+histEsc(t)+'<span class="x" onclick="histRemoveDefect('+i+')">×</span></span>'; }).join("")+
    '<input class="chip-input" id="nf_defect_input" placeholder="add defect" onkeydown="histChipKey(event,\'defect\')">';
}
function histChipKey(e, kind){
  if(e.key!=="Enter") return;
  e.preventDefault(); var v=e.target.value.trim(); if(!v) return;
  if(kind==="tag"){ histEditTags.push(v); histRenderTags(); var i=document.getElementById("nf_tag_input"); if(i) i.focus(); }
  else { histEditDefects.push(v); histRenderDefects(); var j=document.getElementById("nf_defect_input"); if(j) j.focus(); }
}
function histRemoveTag(i){ histEditTags.splice(i,1); histRenderTags(); }
function histRemoveDefect(i){ histEditDefects.splice(i,1); histRenderDefects(); }

function histRenderPhotos(){
  var el=document.getElementById("nf_photos"); if(!el||!histDetail) return;
  var id=encodeURIComponent(histDetail.id);
  var photos=(histDetail.metadata&&histDetail.metadata.photos)||[];
  el.innerHTML = photos.map(function(p){
    return '<div class="photo-thumb'+(p.note?" has-note":"")+'">'+
      '<img src="/api/firings/'+id+'/photos/'+encodeURIComponent(p.file)+'" alt="firing photo" onclick="openPhotoLightbox(\''+p.file+'\')">'+
      '<span class="x" title="remove" onclick="histRemovePhoto(\''+p.file+'\')">×</span></div>';
  }).join("")+
  '<label class="photo-add">+ Photo<input type="file" accept="image/*" style="display:none" onchange="histUploadPhoto(this)"></label>';
}
function histPhotoRefresh(){   // redraw markers + timeline + grid after a photo change
  if(!histDetail) return;
  histBuildCurve(histDetail); histDrawGraph(); histRenderTimeline(histDetail); histRenderPhotos();
}
function histPhotoPick(){ var i=document.getElementById("hist_photo_input"); if(i) i.click(); }
function histUploadPhoto(input){
  if(!input.files||!input.files[0]||!histDetail) return;
  var isLive = (liveFiringId && histDetail.id===liveFiringId);
  var rt = isLive ? liveRuntime : null;
  var fd=new FormData(); fd.append("photo", input.files[0]); input.value="";
  if(rt!=null) fd.append("runtime", rt);
  $.ajax({ url:"/api/firings/"+encodeURIComponent(histDetail.id)+"/photos", type:"POST",
    data:fd, processData:false, contentType:false,
    success:function(r){ if(r&&r.success){
        var entry={file:r.file, note:""}; if(rt!=null) entry.runtime=rt;
        (histDetail.metadata.photos=histDetail.metadata.photos||[]).push(entry); histPhotoRefresh(); }
      else { alert((r&&r.error)||"Upload failed"); } },
    error:function(){ alert("Photo upload failed"); } });
}
function histRemovePhoto(file){
  if(!histDetail) return;
  $.ajax({ url:"/api/firings/"+encodeURIComponent(histDetail.id)+"/photos/"+encodeURIComponent(file), type:"DELETE",
    success:function(){ histDetail.metadata.photos=((histDetail.metadata.photos)||[]).filter(function(p){return p.file!==file;}); histPhotoRefresh(); } });
}

/* ---- photo lightbox (click to view; edit the per-photo note) ---- */
function openPhotoLightbox(file){
  if(!histDetail) return;
  var p=((histDetail.metadata&&histDetail.metadata.photos)||[]).filter(function(x){return x.file===file;})[0]||{file:file};
  var lb=document.getElementById("photo_lightbox");
  if(!lb){ lb=document.createElement("div"); lb.id="photo_lightbox";
    lb.onclick=function(e){ if(e.target===lb) closePhotoLightbox(); };
    document.body.appendChild(lb); }
  var id=encodeURIComponent(histDetail.id);
  var when=(typeof p.runtime==="number")?('<div class="pl-time">📷 at '+histFmtClock(p.runtime)+' elapsed</div>'):"";
  lb.innerHTML='<button class="pl-x" onclick="closePhotoLightbox()">×</button>'+
    '<div class="pl-box">'+
      '<img class="pl-img" src="/api/firings/'+id+'/photos/'+encodeURIComponent(file)+'">'+when+
      '<div class="pl-meta"><textarea id="pl_note" placeholder="Add a note for this photo…">'+histEsc(p.note||"")+'</textarea>'+
      '<button onclick="savePhotoNote(\''+file+'\')">Save</button></div>'+
    '</div>';
  lb.classList.add("open");
  document.addEventListener("keydown", _plEsc);
}
function _plEsc(e){ if(e.key==="Escape") closePhotoLightbox(); }
function closePhotoLightbox(){ var lb=document.getElementById("photo_lightbox"); if(lb) lb.classList.remove("open"); document.removeEventListener("keydown",_plEsc); }
function savePhotoNote(file){
  if(!histDetail) return;
  var ta=document.getElementById("pl_note"); var note=ta?ta.value:"";
  $.ajax({ url:"/api/firings/"+encodeURIComponent(histDetail.id)+"/photos/"+encodeURIComponent(file), type:"PATCH",
    contentType:"application/json", data:JSON.stringify({note:note}),
    success:function(r){ if(r&&r.success){
        var p=((histDetail.metadata&&histDetail.metadata.photos)||[]).filter(function(x){return x.file===file;})[0];
        if(p) p.note=r.photo.note;
        histPhotoRefresh(); closePhotoLightbox();
      } },
    error:function(){ alert("Could not save the photo note."); } });
}

/* ---- standalone text notes (text without a photo) ---- */
function histRenderNoteList(){
  var el=document.getElementById("nf_notes"); if(!el||!histDetail) return;
  var notes=(histDetail.metadata&&histDetail.metadata.notes)||[];
  if(!notes.length){ el.innerHTML='<span class="note-empty">No notes yet — use “+ Note” above the graph.</span>'; return; }
  el.innerHTML = notes.map(function(n){
    var when=(typeof n.runtime==="number")?('<span class="note-when tnum">'+histFmtClock(n.runtime)+'</span>'):"";
    return '<div class="note-item" onclick="openNoteEditor(\''+n.id+'\')">'+when+
      '<span class="note-text">'+histEsc(n.text||"")+'</span>'+
      '<span class="x" title="remove" onclick="event.stopPropagation();histRemoveNote(\''+n.id+'\')">×</span></div>';
  }).join("");
}
function histNoteRefresh(){   // redraw markers + timeline + list after a note change
  if(!histDetail) return;
  histBuildCurve(histDetail); histDrawGraph(); histRenderTimeline(histDetail); histRenderNoteList();
}
function histAddNote(){ openNoteEditor(null); }
function openNoteEditor(nid){
  if(!histDetail) return;
  var note = nid ? (((histDetail.metadata&&histDetail.metadata.notes)||[]).filter(function(x){return x.id===nid;})[0]) : null;
  if(nid && !note) return;
  var isLive = (liveFiringId && histDetail.id===liveFiringId);
  var lb=document.getElementById("note_modal");
  if(!lb){ lb=document.createElement("div"); lb.id="note_modal"; lb.className="note-modal";
    lb.onclick=function(e){ if(e.target===lb) closeNoteEditor(); };
    document.body.appendChild(lb); }
  var when="";
  if(note && typeof note.runtime==="number") when='<div class="nm-time">📝 at '+histFmtClock(note.runtime)+' elapsed</div>';
  else if(!note && isLive) when='<div class="nm-time">📝 at '+histFmtClock(liveRuntime)+' elapsed</div>';
  lb.setAttribute("data-nid", nid||"");
  lb.innerHTML='<div class="nm-box">'+
    '<div class="nm-hd">'+(nid?"Edit note":"Add note")+'</div>'+when+
    '<textarea id="nm_text" placeholder="Type a note…">'+histEsc(note?note.text:"")+'</textarea>'+
    '<div class="nm-actions">'+
      (nid?'<button type="button" class="nm-del" onclick="histRemoveNote(\''+nid+'\',true)">Delete</button>':'')+
      '<button type="button" class="nm-cancel" onclick="closeNoteEditor()">Cancel</button>'+
      '<button type="button" class="nm-save" onclick="saveNoteEditor()">Save</button>'+
    '</div></div>';
  lb.classList.add("open");
  document.addEventListener("keydown", _nmEsc);
  var ta=document.getElementById("nm_text"); if(ta){ ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
}
function _nmEsc(e){ if(e.key==="Escape") closeNoteEditor(); }
function closeNoteEditor(){ var lb=document.getElementById("note_modal"); if(lb) lb.classList.remove("open"); document.removeEventListener("keydown",_nmEsc); }
function saveNoteEditor(){
  if(!histDetail) return;
  var lb=document.getElementById("note_modal"); var nid=lb?lb.getAttribute("data-nid"):"";
  var ta=document.getElementById("nm_text"); var text=ta?ta.value.trim():"";
  if(!text){ if(nid) histRemoveNote(nid,true); else closeNoteEditor(); return; }
  if(nid){
    $.ajax({ url:"/api/firings/"+encodeURIComponent(histDetail.id)+"/notes/"+encodeURIComponent(nid), type:"PATCH",
      contentType:"application/json", data:JSON.stringify({text:text}),
      success:function(r){ if(r&&r.success){
          var arr=(histDetail.metadata.notes)||[]; for(var i=0;i<arr.length;i++){ if(arr[i].id===nid){ arr[i]=r.note; break; } }
          histNoteRefresh(); closeNoteEditor(); } },
      error:function(){ alert("Could not save the note."); } });
  } else {
    var isLive = (liveFiringId && histDetail.id===liveFiringId);
    var body={text:text}; if(isLive) body.runtime=liveRuntime;
    $.ajax({ url:"/api/firings/"+encodeURIComponent(histDetail.id)+"/notes", type:"POST",
      contentType:"application/json", data:JSON.stringify(body),
      success:function(r){ if(r&&r.success){
          (histDetail.metadata.notes=histDetail.metadata.notes||[]).push(r.note); histNoteRefresh(); closeNoteEditor(); }
        else { alert((r&&r.error)||"Could not add the note."); } },
      error:function(){ alert("Could not add the note."); } });
  }
}
function histRemoveNote(nid, fromModal){
  if(!histDetail) return;
  $.ajax({ url:"/api/firings/"+encodeURIComponent(histDetail.id)+"/notes/"+encodeURIComponent(nid), type:"DELETE",
    success:function(){ histDetail.metadata.notes=((histDetail.metadata.notes)||[]).filter(function(n){return n.id!==nid;});
      histNoteRefresh(); if(fromModal) closeNoteEditor(); } });
}

function histSaveNotes(){
  if(!histDetail) return;
  var patch={ title: document.getElementById("nf_title").value,
    tags: histEditTags,
    outcome: { rating: histRating, summary: document.getElementById("nf_summary").value, defects: histEditDefects } };
  $.ajax({ url:"/api/firings/"+encodeURIComponent(histDetail.id), type:"PATCH",
    contentType:"application/json", data:JSON.stringify(patch),
    success:function(r){
      if(r&&r.success){ histDetail.metadata=r.metadata;
        // reflect a (possibly new) title in the list rail + detail heading
        var it=(histList||[]).filter(function(f){return f.id===histDetail.id;})[0]; if(it) it.title=r.metadata.title;
        renderHistList(histDetail.id);
        renderHistDetail(histDetail);
        $("#nf_saved").text("Saved ✓"); setTimeout(function(){ $("#nf_saved").text(""); }, 2500);
      } else { $("#nf_saved").css("color","var(--danger)").text((r&&r.error)||"Save failed"); }
    },
    error:function(){ $("#nf_saved").css("color","var(--danger)").text("Save failed"); } });
}

function histDeleteFiring(){
  if(!histDetail) return;
  if(!confirm("Delete this firing permanently? Its data and photos will be removed and this cannot be undone.")) return;
  var id=histDetail.id;
  $.ajax({ url:"/api/firings/"+encodeURIComponent(id), type:"DELETE",
    success:function(){
      histList=(histList||[]).filter(function(f){return f.id!==id;}); histDetail=null;
      $("#history_view").removeClass("detail-open");
      if(histList.length){ renderHistList(null); if(window.innerWidth>900) loadFiring(histList[0].id); else $("#hist_main").html(""); }
      else { $("#hist_list").html(""); $("#hist_main").html('<div class="hist-empty">No firings recorded yet.</div>'); }
    },
    error:function(){ alert("Could not delete the firing."); } });
}

function histRenderTimeline(d){
  var tl=document.getElementById("hist_timeline"); if(!tl) return; tl.innerHTML="";
  var fid=encodeURIComponent(d.id||"");
  var segs=deriveSegments(d.profile||{});
  // wall-clock at runtime=0, so rows can carry clock time + day/date like the graph
  var startMs=null; if(d.summary&&d.summary.started_at){ var sm=Date.parse(d.summary.started_at); if(!isNaN(sm)) startMs=sm; }
  // combine events and (time-stamped) photos, sorted by runtime, so a photo
  // lands in the timeline at its exact moment
  var rows=[];
  (d.events||[]).forEach(function(e,i){ rows.push({kind:"event", rt:e.runtime||0, e:e, idx:i}); });
  ((d.metadata&&d.metadata.photos)||[]).forEach(function(p){
    if(typeof p.runtime==="number") rows.push({kind:"photo", rt:p.runtime, p:p});
  });
  ((d.metadata&&d.metadata.notes)||[]).forEach(function(n){
    if(typeof n.runtime==="number") rows.push({kind:"note", rt:n.runtime, n:n});
  });
  rows.sort(function(a,b){ return a.rt-b.rt; });
  var prevDay=null;
  rows.forEach(function(r){
    var when=(startMs!=null)?new Date(startMs+r.rt*1000):null;
    // day divider whenever the calendar day shifts (mirrors the graph x-axis)
    if(when){
      var dk=when.getFullYear()+"-"+when.getMonth()+"-"+when.getDate();
      if(dk!==prevDay){
        var dv=document.createElement("div"); dv.className="ev-day tnum";
        dv.textContent=when.toLocaleDateString([],{weekday:"long"})+" · "+
                       when.toLocaleDateString([],{month:"short",day:"numeric"});
        tl.appendChild(dv); prevDay=dk;
      }
    }
    var timeHtml='<span class="ev-time tnum">'+
      (when?('<span class="ev-clock">'+histEsc(clockTime(when))+'</span>'):'')+
      '<span class="ev-elapsed">'+histFmtClock(r.rt)+' elapsed</span></span>';
    var row=document.createElement("div"); row.className="ev";
    if(r.kind==="event"){
      var def=HIST_EV[r.e.type]||{c:"var(--muted)",i:"·",t:function(){return [r.e.type,""];}};
      var tt=(r.e.type==="segment_transition")?histSegText(r.e,segs):def.t(r.e);
      var title=tt[0], sub=tt[1];
      var plain=(r.e.type==="segment_transition");   // segment marker: no filled circle
      // inline !important so the colors survive Bootstrap's print reset
      // (* { background:transparent!important; color:#000!important }), which
      // index.html loads but the standalone report page does not
      var icoStyle=plain?('color:'+def.c+' !important')
                        :('background:'+def.c+' !important;color:#fff !important');
      row.tabIndex=0; row.setAttribute("data-idx",r.idx); row.setAttribute("data-col",histCssVar(def.c));
      row.innerHTML=timeHtml+
        '<span class="ev-ico'+(plain?' plain':'')+'" style="'+icoStyle+'">'+def.i+'</span>'+
        '<span class="ev-txt"><b>'+histEsc(title)+'</b>'+(sub?' <span class="ev-sub">— '+histEsc(sub)+'</span>':'')+'</span>';
      row.onclick=function(){ histSelectEvent(r.idx); };
      row.onkeydown=function(ev){ if(ev.key==="Enter"||ev.key===" "){ ev.preventDefault(); histSelectEvent(r.idx); } };
    } else if(r.kind==="photo"){
      var note=r.p.note?(' — '+histEsc(r.p.note)):"";
      // the photo itself is the bullet in the icon column
      row.innerHTML=timeHtml+
        '<img class="ev-ico-photo" src="/api/firings/'+fid+'/photos/'+encodeURIComponent(r.p.file)+'" '+
        'onclick="openPhotoLightbox(\''+r.p.file+'\')">'+
        '<span class="ev-txt"><b>Photo</b><span class="ev-sub">'+note+'</span></span>';
    } else {   // standalone text note
      row.innerHTML=timeHtml+
        '<span class="ev-ico plain" style="color:var(--muted) !important">📝</span>'+
        '<span class="ev-txt"><b>Note</b> <span class="ev-sub">— '+histEsc(r.n.text||"")+'</span></span>';
      row.style.cursor="pointer";
      row.onclick=(function(id){ return function(){ openNoteEditor(id); }; })(r.n.id);
    }
    tl.appendChild(row);
  });
}

function histSelectEvent(idx){
  histSel = (histSel===idx)?null:idx;
  $("#hist_timeline .ev").each(function(){
    var on = (+this.getAttribute("data-idx")===histSel);
    this.className = "ev"+(on?" sel":"");
    this.style.boxShadow = on ? ("inset 3px 0 0 "+this.getAttribute("data-col")) : "";
  });
  histUpdateSelCap(); histDrawGraph();
}
function histSelectFromGraph(idx){
  histSelectEvent(idx);
  if(histSel!=null){ var row=document.querySelector('#hist_timeline .ev[data-idx="'+histSel+'"]'); if(row) row.scrollIntoView({block:"nearest",behavior:"smooth"}); }
}
function histUpdateSelCap(){
  var cap=document.getElementById("hist_selcap"); if(!cap) return;
  if(histSel==null || !histCurve || !histCurve.events[histSel]){ cap.innerHTML='<span class="muted">Tip: select an event below to mark it on the graph</span>'; return; }
  var e=histCurve.events[histSel], def=HIST_EV[e.type]||{c:"var(--ink)",t:function(){return [e.type,""];}};
  var tt=(e.type==="segment_transition")?histSegText(e, deriveSegments((histDetail&&histDetail.profile)||{})):def.t(e);
  cap.innerHTML='<span class="seldot" style="background:'+histCssVar(def.c)+'"></span><b>'+histEsc(tt[0])+'</b>'+
    (tt[1]?' <span class="muted">— '+histEsc(tt[1])+'</span>':'')+
    ' <span class="muted tnum">· '+histFmtClock(e.runtime||0)+' elapsed</span>'+
    '<button type="button" class="selx" onclick="histSelectEvent('+histSel+')">clear</button>';
}

// Reconstruct the estimated remaining schedule as [runtime, temp] waypoints,
// mirroring the server's SegmentScheduler.remaining_seconds (on-rate from the
// current setpoint), so the projected end lines up with the "done" clock time.
// `x` is a RUNNING /status message. Returns [] if we can't project.
function buildProjection(x){
  var segs = x && x.segments;
  if(!segs || x.segment==null || x.segment>=segs.length || x.phase==null) return [];
  var t = x.runtime, sp = x.target;                    // now, at the current setpoint
  // start at the actual tip so the dotted line continues the live curve
  var tip = (graph.live && graph.live.data && graph.live.data.length) ? graph.live.data[graph.live.data.length-1] : null;
  var pts = [[t, tip ? tip[1] : sp]];
  var seg = segs[x.segment];
  if(x.phase === 'RAMP'){
    var rate = (seg.rate||0)/3600;                     // deg/hr -> deg/s
    if(rate>0 && seg.target!==sp) t += Math.abs(seg.target-sp)/rate;
    sp = seg.target; pts.push([t, sp]);
    if(seg.hold>0){ t += seg.hold; pts.push([t, sp]); }
  } else { // HOLD: only the remaining soak of this segment is left
    var holdRem = Math.max(0, x.segment_remaining||0);
    if(holdRem>0){ t += holdRem; pts.push([t, sp]); }
  }
  for(var i=x.segment+1; i<segs.length; i++){
    var s=segs[i], r=(s.rate||0)/3600;
    if(r>0 && s.target!==sp) t += Math.abs(s.target-sp)/r;
    sp = s.target; pts.push([t, sp]);
    if(s.hold>0){ t += s.hold; pts.push([t, sp]); }
  }
  return pts;
}

function histBuildCurve(d){
  var act=(d.samples||[]).map(function(s){return [s.runtime,s.temperature];});
  var plan=((d.profile&&d.profile.data)||[]).map(function(p){return [p[0],p[1]];});
  var xmax=0,ymax=0;
  act.forEach(function(p){xmax=Math.max(xmax,p[0]); ymax=Math.max(ymax,p[1]);});
  plan.forEach(function(p){xmax=Math.max(xmax,p[0]); ymax=Math.max(ymax,p[1]);});
  ymax=Math.ceil((ymax*1.08)/100)*100||100;
  var bands=[], open=null;
  (d.events||[]).forEach(function(e){ if(e.type==="power_interruption") open=e.runtime;
    else if(e.type==="resumed"&&open!=null){ bands.push([open,e.runtime]); open=null; } });
  // photos/notes with a capture runtime become markers on the graph / rows in the timeline
  var photos=((d.metadata&&d.metadata.photos)||[]).filter(function(p){return typeof p.runtime==="number";});
  var notes=((d.metadata&&d.metadata.notes)||[]).filter(function(n){return typeof n.runtime==="number";});
  // wall-clock at runtime=0, for a clock-time x-axis (falls back to duration if absent)
  var startMs=null; if(d.summary&&d.summary.started_at){ var sm=Date.parse(d.summary.started_at); if(!isNaN(sm)) startMs=sm; }
  histCurve={act:act,plan:plan,proj:[],xmax:xmax||1,ymax:ymax,events:d.events||[],bands:bands,photos:photos,notes:notes,startMs:startMs};
}

// Live curve: actual from the /status websocket stream (graph.live.data) and
// planned from the running profile (graph.profile.data, reflects live edits) —
// no samples fetched from the server. Events/photos come from histDetail
// (refreshed by the light poll).
function histBuildCurveLive(){
  if(!histDetail) return;
  var act=(graph.live&&graph.live.data?graph.live.data:[]).map(function(p){return [p[0],p[1]];});
  var plan=(graph.profile&&graph.profile.data&&graph.profile.data.length?graph.profile.data
            :((histDetail.profile&&histDetail.profile.data)||[])).map(function(p){return [p[0],p[1]];});
  var proj=graph_projection||[];
  var xmax=0,ymax=0;
  act.forEach(function(p){xmax=Math.max(xmax,p[0]); ymax=Math.max(ymax,p[1]);});
  plan.forEach(function(p){xmax=Math.max(xmax,p[0]); ymax=Math.max(ymax,p[1]);});
  proj.forEach(function(p){xmax=Math.max(xmax,p[0]); ymax=Math.max(ymax,p[1]);});
  ymax=Math.ceil((ymax*1.08)/100)*100||100;
  var bands=[], open=null;
  (histDetail.events||[]).forEach(function(e){ if(e.type==="power_interruption") open=e.runtime;
    else if(e.type==="resumed"&&open!=null){ bands.push([open,e.runtime]); open=null; } });
  var photos=((histDetail.metadata&&histDetail.metadata.photos)||[]).filter(function(p){return typeof p.runtime==="number";});
  var notes=((histDetail.metadata&&histDetail.metadata.notes)||[]).filter(function(n){return typeof n.runtime==="number";});
  // live: graph_start_ms is the wall-clock at runtime=0; fall back to the record's started_at
  var startMs=graph_start_ms;
  if(startMs==null && histDetail.summary && histDetail.summary.started_at){ var sm=Date.parse(histDetail.summary.started_at); if(!isNaN(sm)) startMs=sm; }
  histCurve={act:act,plan:plan,proj:proj,xmax:xmax||1,ymax:ymax,events:histDetail.events||[],bands:bands,photos:photos,notes:notes,startMs:startMs};
}
var _liveTickAt=0;
function histLiveTick(){   // called from the /status handler; redraw live curve, throttled
  if(!liveFiringId || !histDetail || !$("#live_detail").is(":visible") || !document.getElementById("hist_graph")) return;
  var now=(new Date()).getTime(); if(now-_liveTickAt < 1500) return; _liveTickAt=now;
  histBuildCurveLive(); histDrawGraph();
}

function histDrawGraph(){
  var cv=document.getElementById("hist_graph"); if(!cv||!histCurve) return;
  var dpr=window.devicePixelRatio||1, W=cv.clientWidth, H=cv.clientHeight;
  cv.width=W*dpr; cv.height=H*dpr;
  var g=cv.getContext("2d"); g.setTransform(dpr,0,0,dpr,0,0); g.clearRect(0,0,W,H);
  var m={l:46,r:14,t:18,b:40}, pw=W-m.l-m.r, ph=H-m.t-m.b;
  var X=function(x){return m.l+(x/histCurve.xmax)*pw;}, Y=function(y){return m.t+ph-(y/histCurve.ymax)*ph;};

  histCurve.bands.forEach(function(b){
    var x0=X(b[0]), x1=X(b[1]);
    g.fillStyle="rgba(255,59,48,.07)"; g.fillRect(x0,m.t,Math.max(2,x1-x0),ph);
    g.strokeStyle="rgba(255,59,48,.35)"; g.lineWidth=1; g.setLineDash([3,3]);
    g.beginPath(); g.moveTo(x0,m.t); g.lineTo(x0,m.t+ph); g.moveTo(x1,m.t); g.lineTo(x1,m.t+ph); g.stroke(); g.setLineDash([]);
  });

  g.fillStyle="#9aa3b2"; g.font="11px -apple-system,system-ui,sans-serif"; g.lineWidth=1;
  g.textAlign="right"; g.textBaseline="middle";
  var ystep=histNiceStep(histCurve.ymax,5);
  for(var v=0; v<=histCurve.ymax+1; v+=ystep){ var y=Y(v);
    g.strokeStyle="#e6e9ef"; g.globalAlpha=.8; g.beginPath(); g.moveTo(m.l,y); g.lineTo(W-m.r,y); g.stroke(); g.globalAlpha=1;
    g.fillText(v.toFixed(0), m.l-8, y); }
  g.textAlign="center"; g.textBaseline="top";
  if(histCurve.startMs){
    // clock-time axis on round hours; tag the first tick of each new calendar day
    var ticks=histClockTicks(histCurve.startMs, histCurve.xmax, W<560?4:7), prevDay=null;
    ticks.forEach(function(rt){
      if(rt<-1 || rt>histCurve.xmax+1) return;
      var dt=new Date(histCurve.startMs+rt*1000), px=X(rt);
      g.fillStyle="#9aa3b2"; g.fillText(histClockShort(dt), px, m.t+ph+8);
      var dk=dt.getFullYear()+"-"+dt.getMonth()+"-"+dt.getDate();
      if(dk!==prevDay){ g.fillStyle="#6b7280"; g.fillText(dt.toLocaleDateString([],{weekday:"short"}), px, m.t+ph+21); }
      prevDay=dk;
    });
  } else {
    var xstep=histNiceStep(histCurve.xmax,6);
    for(var xv=0; xv<=histCurve.xmax+1; xv+=xstep){ g.fillText(histFmtClock(xv), X(xv), m.t+ph+8); }
  }
  g.textAlign="left"; g.fillStyle="#9aa3b2"; g.fillText(histTU(), 6, m.t-2);

  if(histCurve.plan.length){
    g.strokeStyle="#0a84ff"; g.lineWidth=1.6; g.setLineDash([5,4]); g.beginPath();
    histCurve.plan.forEach(function(p,i){ var x=X(p[0]),y=Y(p[1]); i?g.lineTo(x,y):g.moveTo(x,y); });
    g.stroke(); g.setLineDash([]);
  }
  if(histCurve.proj&&histCurve.proj.length){
    // estimated remaining schedule: gray dotted, drawn under the actual curve
    g.strokeStyle="#9aa3b2"; g.lineWidth=1.8; g.lineCap="round"; g.setLineDash([0.5,5]); g.beginPath();
    histCurve.proj.forEach(function(p,i){ var x=X(p[0]),y=Y(p[1]); i?g.lineTo(x,y):g.moveTo(x,y); });
    g.stroke(); g.setLineDash([]); g.lineCap="butt";
    var pe=histCurve.proj[histCurve.proj.length-1];
    g.fillStyle="#9aa3b2"; g.beginPath(); g.arc(X(pe[0]),Y(pe[1]),3,0,7); g.fill();
  }
  if(histCurve.act.length){
    var grad=g.createLinearGradient(0,m.t,0,m.t+ph);
    grad.addColorStop(0,"rgba(255,107,53,.22)"); grad.addColorStop(1,"rgba(255,107,53,0)");
    g.beginPath(); histCurve.act.forEach(function(p,i){ var x=X(p[0]),y=Y(p[1]); i?g.lineTo(x,y):g.moveTo(x,y); });
    var last=histCurve.act[histCurve.act.length-1], first=histCurve.act[0];
    g.lineTo(X(last[0]),Y(0)); g.lineTo(X(first[0]),Y(0)); g.closePath(); g.fillStyle=grad; g.fill();
    g.beginPath(); g.strokeStyle="#ff6b35"; g.lineWidth=2.2; g.lineJoin="round";
    histCurve.act.forEach(function(p,i){ var x=X(p[0]),y=Y(p[1]); i?g.lineTo(x,y):g.moveTo(x,y); });
    g.stroke();
    g.fillStyle="#ff6b35"; g.beginPath(); g.arc(X(last[0]),Y(last[1]),3.5,0,7); g.fill();
  }

  histPins=[];
  histCurve.events.forEach(function(e,idx){
    if(e.type==="segment_transition"||e.type==="resumed") return;
    var def=HIST_EV[e.type]; if(!def) return; var x=X(e.runtime||0);
    histPins.push({x:x,idx:idx});
    g.strokeStyle="rgba(17,21,28,.08)"; g.lineWidth=1; g.beginPath(); g.moveTo(x,m.t); g.lineTo(x,m.t+ph); g.stroke();
    g.fillStyle=histCssVar(def.c); g.beginPath(); g.arc(x,m.t-1,3.2,0,7); g.fill();
  });
  if(histSel!=null && histCurve.events[histSel]){
    var se=histCurve.events[histSel], sdef=HIST_EV[se.type]||{c:"var(--ink)"}, col=histCssVar(sdef.c), sx=X(se.runtime||0);
    g.strokeStyle=col; g.lineWidth=1.6; g.setLineDash([4,3]); g.beginPath(); g.moveTo(sx,m.t-4); g.lineTo(sx,m.t+ph); g.stroke(); g.setLineDash([]);
    g.fillStyle=col; g.beginPath(); g.arc(sx,m.t-4,4.5,0,7); g.fill();
    var yv=histInterp(histCurve.act, se.runtime||0);
    if(yv!=null){ var py=Y(yv); g.fillStyle="#fff"; g.strokeStyle=col; g.lineWidth=2.5; g.beginPath(); g.arc(sx,py,5.5,0,7); g.fill(); g.stroke(); }
  }

  // photo markers (camera glyph) along the bottom axis, click-to-view
  histPhotoPins=[];
  (histCurve.photos||[]).forEach(function(p){
    var x=X(p.runtime||0);
    histPhotoPins.push({x:x, photo:p});
    g.strokeStyle="rgba(107,114,128,.45)"; g.lineWidth=1; g.setLineDash([2,3]);
    g.beginPath(); g.moveTo(x,m.t); g.lineTo(x,m.t+ph); g.stroke(); g.setLineDash([]);
    g.font="13px -apple-system,system-ui,sans-serif"; g.textAlign="center"; g.textBaseline="bottom";
    g.fillText("📷", x, m.t+ph-1);
  });

  // note markers (memo glyph) along the bottom axis, click-to-edit
  histNotePins=[];
  (histCurve.notes||[]).forEach(function(n){
    var x=X(n.runtime||0);
    histNotePins.push({x:x, note:n});
    g.strokeStyle="rgba(107,114,128,.45)"; g.lineWidth=1; g.setLineDash([2,3]);
    g.beginPath(); g.moveTo(x,m.t); g.lineTo(x,m.t+ph); g.stroke(); g.setLineDash([]);
    g.font="13px -apple-system,system-ui,sans-serif"; g.textAlign="center"; g.textBaseline="bottom";
    g.fillText("📝", x, m.t+ph-1);
  });

  histDrawCrosshair();
}

var histHoverX=null;
function histDrawCrosshair(){
  var cv=document.getElementById("hist_graph"); if(histHoverX==null||!histCurve||!cv) return;
  if(!histCurve.act.length && !histCurve.plan.length) return;
  var g=cv.getContext("2d"), W=cv.clientWidth, H=cv.clientHeight;
  var m={l:46,r:14,t:18,b:40}, pw=W-m.l-m.r, ph=H-m.t-m.b;
  // free-track the cursor across the whole x range (clamped to the plot), so the
  // planned/future portion is inspectable too — not just where actual data exists
  var xv=Math.max(0, Math.min(histCurve.xmax, (histHoverX-m.l)/pw*histCurve.xmax));
  var X=function(x){return m.l+(x/histCurve.xmax)*pw;}, Y=function(y){return m.t+ph-(y/histCurve.ymax)*ph;};
  // actual only exists up to the last sample; interpolate the plan everywhere
  var lastActRt=histCurve.act.length?histCurve.act[histCurve.act.length-1][0]:-1;
  var av=(histCurve.act.length && xv<=lastActRt+1)?histInterp(histCurve.act,xv):null;
  var pv=histInterp(histCurve.plan,xv);
  var px=X(xv);
  g.strokeStyle="rgba(17,21,28,.22)"; g.lineWidth=1; g.setLineDash([2,3]); g.beginPath(); g.moveTo(px,m.t); g.lineTo(px,m.t+ph); g.stroke(); g.setLineDash([]);
  // marker sits on the actual curve when present, otherwise on the planned curve
  var dotY=(av!=null)?Y(av):(pv!=null?Y(pv):null), dotCol=(av!=null)?"#ff6b35":"#0a84ff";
  if(dotY!=null){ g.fillStyle="#fff"; g.strokeStyle=dotCol; g.lineWidth=2; g.beginPath(); g.arc(px,dotY,4,0,7); g.fill(); g.stroke(); }
  var when=histCurve.startMs ? (clockTimeDay(new Date(histCurve.startMs+xv*1000))+' &middot; '+histFmtClock(xv)+' elapsed') : (histFmtClock(xv)+' elapsed');
  var tip=document.getElementById("hist_tip");
  tip.style.opacity=1; tip.style.left=px+"px"; tip.style.top=(dotY!=null?dotY:m.t+ph/2)+"px";
  tip.innerHTML='<div class="tt-t">'+when+'</div>'+
    (av!=null?'<div class="tt-row"><span class="d" style="background:#ff6b35"></span>Actual <b style="margin-left:auto">'+Math.round(av)+'°</b></div>':'')+
    (pv!=null?'<div class="tt-row"><span class="d" style="background:#0a84ff"></span>Planned <b style="margin-left:auto">'+Math.round(pv)+'°</b></div>':'');
}
function histInterp(pts,x){
  if(!pts||!pts.length) return null;
  if(x<=pts[0][0]) return pts[0][1]; if(x>=pts[pts.length-1][0]) return pts[pts.length-1][1];
  for(var i=0;i<pts.length-1;i++){ if(pts[i+1][0]>=x){ var a=pts[i],b=pts[i+1]; return a[1]+(b[1]-a[1])*(x-a[0])/((b[0]-a[0])||1); } }
  return null;
}
function histNiceStep(max,n){ var raw=max/n, p=Math.pow(10,Math.floor(Math.log10(raw||1))), c=raw/p; var s=c<1.5?1:c<3?2:c<7?5:10; return s*p||1; }
function histCssVar(v){ if(v&&v.indexOf("var(")===0){ return getComputedStyle(document.documentElement).getPropertyValue(v.slice(4,-1)).trim()||"#999"; } return v; }

document.addEventListener("mousemove",function(e){
  var cv=document.getElementById("hist_graph"); if(!cv) return; var r=cv.getBoundingClientRect();
  if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom){ if(histHoverX!=null){ histHoverX=null; var t=document.getElementById("hist_tip"); if(t)t.style.opacity=0; histDrawGraph(); } return; }
  histHoverX=e.clientX-r.left; histDrawGraph();
});
document.addEventListener("click",function(e){
  var cv=document.getElementById("hist_graph"); if(!cv) return; var r=cv.getBoundingClientRect();
  if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom) return;
  var x=e.clientX-r.left, y=e.clientY-r.top;
  // bottom band → photo (camera) / note (memo) markers, nearest wins
  if(y > cv.clientHeight-44 && (histPhotoPins.length || histNotePins.length)){
    var hit=null, bbd=16;
    histPhotoPins.forEach(function(p){ var dd=Math.abs(p.x-x); if(dd<bbd){ bbd=dd; hit={kind:"photo",p:p}; } });
    histNotePins.forEach(function(p){ var dd=Math.abs(p.x-x); if(dd<bbd){ bbd=dd; hit={kind:"note",p:p}; } });
    if(hit){ if(hit.kind==="photo") openPhotoLightbox(hit.p.photo.file); else openNoteEditor(hit.p.note.id); return; }
  }
  if(!histPins.length) return;
  var best=null, bd=14;
  histPins.forEach(function(p){ var dd=Math.abs(p.x-x); if(dd<bd){ bd=dd; best=p.idx; } });
  if(best!=null) histSelectFromGraph(best);
});
var histRT; window.addEventListener("resize",function(){
  if($("#history_view").is(":visible")||$("#live_detail").is(":visible")){ clearTimeout(histRT); histRT=setTimeout(histDrawGraph,80); } });

/* deep-link: #history opens the history view (bookmarkable; the cloud proxy
   can link straight to it). showHistory/showLive keep the hash in sync. */
$(function(){
  if(location.hash==="#history") showHistory();
  window.addEventListener("hashchange",function(){
    if(location.hash==="#history"){ if(!$("#history_view").is(":visible")) showHistory(); }
    else if($("#history_view").is(":visible")) showLive();
  });
});

/* =======================================================================
   In-progress firing: show the same detail view (annotated graph + live
   timeline + editable notes) for the firing currently being recorded,
   live-updating by polling /api/firings/<firing_id>. (feature 2 + 3)
   ======================================================================= */
function updateLiveView(x){
  if(typeof x.runtime==="number") liveRuntime=x.runtime;
  var fid=x.firing_id;
  if(x.state==="RUNNING"){
    // Only switch to the live detail once we also have the firing id. A RUNNING
    // status without one yet: keep waiting, don't reveal the idle panel.
    if(fid){
      if($("#live_view").is(":visible")){ $("#live_view > .panel").hide(); $("#live_detail").show(); }
      if(liveFiringId!==fid){ liveFiringId=fid; enterLiveDetail(fid); }
    }
  } else if(liveFiringId!==null){
    liveFiringId=null; exitLiveDetail();
  } else if(x.state){
    // A real, non-running state (IDLE/DONE/…): reveal the flot preview panel
    // (hidden by default). Idempotent after the first. We gate on x.state being
    // set so the initial stateless "backlog" message doesn't flash the panel
    // before we know whether a firing is running.
    showIdlePanel();
  }
}
// Reveal the idle flot preview/editor panel and plot it. The panel is
// display:none in the markup so a refresh into a RUNNING firing goes straight
// to #live_detail without flashing the old graph; this brings it back for idle.
function showIdlePanel(){
  var panel=$("#live_view > .panel");
  if(panel.css("display")!=="none") return;   // already revealed
  panel.show();
  // $.plot needs a sized, on-screen container; if live_view is hidden (e.g. the
  // history view is open) showLive() will plot on return instead.
  if($("#graph_container").is(":visible"))
    graph.plot = $.plot("#graph_container", [ graph.profile, graph.live ], getOptions());
}
function enterLiveDetail(fid){
  $("#hist_main").empty();   // avoid duplicate element ids if the history view was open
  // One heavy read on open to seed the actual curve with the firing's history so
  // far; after that the curve is driven by the /status websocket (histLiveTick)
  // and the recurring poll is light (?samples=0) — just events / notes / summary.
  $.getJSON("/api/firings/"+encodeURIComponent(fid)+"?resolution=800").done(function(d){
    histDetail=d; histSel=null; renderHistDetail(d, "#live_detail_body");
    segment_editor_count = -1;   // force manageSegmentEditor to (re)fill the new #segment_table
    seedLiveCurve(d);            // prime graph.live.data so the websocket can append
  });
  if(livePollTimer) clearInterval(livePollTimer);
  livePollTimer=setInterval(function(){
    if(liveFiringId!==fid){ clearInterval(livePollTimer); livePollTimer=null; return; }
    $.getJSON("/api/firings/"+encodeURIComponent(fid)+"?samples=0").done(histRefreshLive);
  }, 12000);
}
// Seed the live actual-curve buffer from the firing's recorded samples (only if
// the websocket hasn't already accumulated more), then draw from the websocket.
function seedLiveCurve(d){
  var s=d.samples||[];
  if(s.length > ((graph.live&&graph.live.data)?graph.live.data.length:0))
    graph.live.data = s.map(function(p){return [p.runtime, p.temperature];});
  histBuildCurveLive(); if(document.getElementById("hist_graph")) histDrawGraph();
}
function histRefreshLive(d){
  // Light poll (no samples): refresh events / notes / summary; the actual curve
  // comes from the websocket via histBuildCurveLive(). Bail if the user navigated
  // to history (its canvas would otherwise be clobbered) or nothing is loaded.
  if(!liveFiringId || !$("#live_detail").is(":visible")) return;
  if(!histDetail || histDetail.id!==d.id || !document.getElementById("hist_graph")) return;
  histDetail.summary=d.summary; histDetail.events=d.events;
  // refresh photos from the server only if it has at least as many (so a stale
  // poll can't drop a photo the user just added locally)
  if(d.metadata && (d.metadata.photos||[]).length >= ((histDetail.metadata&&histDetail.metadata.photos)||[]).length)
    histDetail.metadata.photos = d.metadata.photos;
  $("#live_detail_body .stats").html(histStatsHtml(d.summary));
  $("#live_detail_body .dh-pill").attr("class","pill dh-pill "+(d.summary.status||"")).text(d.summary.status||"");
  histBuildCurveLive(); histDrawGraph(); histRenderTimeline(histDetail); histUpdateSelCap();
}
function exitLiveDetail(){
  if(livePollTimer){ clearInterval(livePollTimer); livePollTimer=null; }
  segments_armed=false;
  $("#live_detail").hide(); $("#live_detail_body").empty();
  showIdlePanel();   // a firing just ended -> back to the idle preview panel
  loadMru();   // ...and refresh the recent list
}
// "Edit schedule" toggle: swap the timeline + notes for the ramp/target/hold list
function toggleLiveSegments(){
  var on = !$("#btn_edit_sched").hasClass("on");
  $("#btn_edit_sched").toggleClass("on", on)
    .html(on ? '<span class="glyphicon glyphicon-ok"></span> Done' : '<span class="glyphicon glyphicon-edit"></span> Edit schedule');
  $("#seg_section").toggle(on);
  $("#tl_section").toggle(!on);
  $("#notes_card").toggle(!on);
  segments_armed = on;
  if(!on) selected_segment = -1;
  if(typeof applySegmentsEditable==="function") applySegmentsEditable();
}

/* recent-firings (MRU) quick pick — the last 7 distinct profiles you've fired,
   shown in the idle view for one-tap selection before starting. */
function loadMru(){
  var el=document.getElementById("mru_firings"); if(!el) return;
  $.getJSON("/api/firings").done(function(list){
    var seen={}, items=[];
    (list||[]).forEach(function(f){ var n=f.profile_name; if(n && !seen[n]){ seen[n]=1; items.push(f); } });
    items=items.slice(0,7);
    if(!items.length){ el.innerHTML=""; return; }
    el.innerHTML='<span class="mru-label">Recent:</span>'+items.map(function(f){
      return '<button type="button" class="mru-chip" data-name="'+histEsc(f.profile_name)+'">'+histEsc(f.title||f.profile_name)+'</button>';
    }).join("");
    $(el).find(".mru-chip").each(function(){ var nm=this.getAttribute("data-name");
      this.onclick=function(){ selectProfileByName(nm); }; });
  });
}
function selectProfileByName(name){
  if(typeof profiles==="undefined" || !profiles) return;
  for(var i=0;i<profiles.length;i++){
    if(profiles[i].name===name){ selected_profile=i; selected_profile_name=name; $('#e2').val(i); updateProfile(i); return; }
  }
  $.bootstrapGrowl("That profile (\""+histEsc(name)+"\") is no longer saved.",
    {type:"warning", align:"center", width:380, delay:3500});
}
