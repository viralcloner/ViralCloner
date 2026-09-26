$.fn.range = function (min, max, initial, onChange) {
    var dragged = null;
    return this.each(function () {
        var $range = $(this);
        if( !$range.find(".dot").length ) {
            $range.append("<span class='dot'></span>");
        }
        setValue(countPercentage(initial));
        $range.on("mousedown", function () { dragged = $range; });
        $range.on("click", function (e) {
            var offset = $range.offset();
            var width = $range.outerWidth();
            var relativeX = Math.min(Math.max(e.pageX - offset.left, 0), width);
            var percent = (relativeX / width) * 100;
            setValue(percent);
            onChange(parseInt(countValue(percent)));
        });
        $("body").on("mousemove", function (e) {
            if( dragged ) {
                var offset = dragged.offset();
                var width = dragged.outerWidth();
                var relativeX = Math.min(Math.max(e.pageX - offset.left, 0), width);
                var percent = (relativeX / width) * 100;
                dragged.css("background", "linear-gradient(to right, #bbbbbb " + percent + "%, #bbbbbb49 0%)");
                dragged.find(".dot").css("left", `calc(${percent}% - 10px)`);
                if (onChange && typeof onChange === "function") {
                    onChange(parseInt(countValue(percent)));
                }
            }
        });
        $(document).on("mouseleave mouseup", function() { dragged = null; });
        function setValue(val) {
            $range.css("background", "linear-gradient(to right, #bbbbbb " + val + "%, #bbbbbb49 0%)");
            $range.find(".dot").css("left", `calc(${val}% - 10px)`);
        }
        function countPercentage(val) {
            return ((val - min) / (max - min)) * 100;
        }
        function countValue(percent) {
            return min + ((max - min) * (percent / 100));
        }
    });
}

$.fn.changeRange = function (val) {
    return this.each(function () {
        var $range = $(this);
        $range.css("background", "linear-gradient(to right, #bbbbbb " + val + "%, #bbbbbb49 0%)");
        $range.find(".dot").css("left", `calc(${val}% - 10px)`);
    });
};